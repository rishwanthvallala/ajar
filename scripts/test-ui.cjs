const assert = require("node:assert/strict");
const net = require("node:net");
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

/**
 * A strict port that is already taken is a setup problem, and it has to be
 * reported as one. Without this the suite races: a foreign server answers the
 * probe immediately, `ready` returns happy, and the checks run against
 * somebody else's process while ours dies quietly in the background.
 */
function portFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) =>
      error.code === "EADDRINUSE"
        ? reject(new Error(`Port ${port} is already in use — stop whatever holds it and rerun.`))
        : reject(error),
    );
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, "127.0.0.1");
  });
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
    // Both pages are watched. Watching only one and reporting on both is how
    // this check came to claim more than it tested.
    const ajarErrors = [];
    const ajar = await context.newPage();
    ajar.on("pageerror", (error) => ajarErrors.push(`pageerror: ${error.message}`));
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
    assert.equal(
      await padPage.locator("#preview-pane").isHidden(),
      true,
      "Pad preview pane must not consume a grid row before a server is opened",
    );
    await padPage.locator(".xterm").waitFor({ state: "attached" });
    const editorState = await padPage.evaluate(() => {
      const editor = window.monaco.editor.getEditors()[0];
      editor.setValue("layout state");
      editor.executeEdits("layout-check", [{
        range: new window.monaco.Range(1, 13, 1, 13),
        text: " survives",
      }]);
      return editor.getValue();
    });
    await padPage.locator("#splitter").focus();
    await padPage.keyboard.press("ArrowUp");
    await padPage.emulateMedia({ colorScheme: "dark" });
    await padPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(
      await padPage.evaluate(() => window.monaco.editor.getEditors()[0].getValue()),
      editorState,
      "Pad layout and theme changes preserve editor content",
    );
    assert.equal(
      await padPage.evaluate(() => window.monaco.editor.getEditors()[0].getModel().canUndo()),
      true,
      "Pad layout and theme changes preserve Monaco undo history",
    );
    await padPage.locator(".xterm-helper-textarea").focus();
    await padPage.keyboard.type("pending-command");
    // Drawn before the resize, or this measures how fast a busy machine
    // renders typing rather than whether a resize keeps it — macOS CI read
    // `$ pend` here, the rest still on its way to the screen.
    const drawn = () => padPage.waitForFunction(
      () => /pending-command/.test(document.querySelector(".xterm-rows")?.innerText ?? ""),
      null,
      { timeout: 10_000 },
    );
    await drawn();
    await padPage.locator("#splitter").focus();
    await padPage.keyboard.press("ArrowDown");
    await drawn().catch(() => {});
    assert.match(await padPage.locator(".xterm-rows").innerText(), /pending-command/, "Pad resize preserves terminal contents");
    assert.deepEqual(ajarErrors, []);
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
async function requireBrowser() {
  const { chromium } = webRequire("playwright");
  try {
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : undefined,
      headless: true,
    });
    await browser.close();
  } catch (error) {
    // Fatal, everywhere. A gate that quietly downgrades itself on the machine
    // where someone is about to commit is worse than one that is simply absent,
    // because it still reports success. Skipping is check.sh's to offer, and it
    // stops saying "all green" when it does.
    throw new Error(
      `${error.message.split("\n")[0]}\n` +
        "  Install the browser with: npm exec --workspace web -- playwright install chromium\n" +
        "  Or skip this suite deliberately with: AJAR_SKIP_UI=1 ./scripts/check.sh",
    );
  }
}

async function main() {
  await requireBrowser();
  for (const port of [5173, 5174, 5175, 5176]) await portFree(port);
  const viteBin = (workspaceRequire) =>
    path.join(path.dirname(workspaceRequire.resolve("vite/package.json")), "bin", "vite.js");
  const webVite = viteBin(webRequire);
  const padVite = viteBin(padRequire);
  const dev = start(web, webVite, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  const webPreview = start(web, webVite, ["preview", "--host", "127.0.0.1", "--port", "5174", "--strictPort"]);
  const padPreview = start(pad, padVite, ["preview", "--host", "127.0.0.1", "--port", "5175", "--strictPort"]);
  const padDev = start(pad, padVite, ["--host", "127.0.0.1", "--port", "5176", "--strictPort"]);

  await Promise.all([
    ready("http://127.0.0.1:5173/", dev),
    ready("http://127.0.0.1:5174/", webPreview),
    ready("http://127.0.0.1:5175/", padPreview),
    ready("http://127.0.0.1:5176/", padDev),
  ]);
  await run(path.join(root, "scripts", "check-workspace-layout.cjs"), {
    AJAR_PRODUCTION_URL: "http://127.0.0.1:5174",
  });
  await run(path.join(root, "scripts", "check-pad-layout.cjs"), {
    PAD_PREVIEW_URL: "http://127.0.0.1:5176",
    PAD_PRODUCTION_URL: "http://127.0.0.1:5175",
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

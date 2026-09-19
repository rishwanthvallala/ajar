const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const webRequire = createRequire(path.resolve(__dirname, "../web/package.json"));
const { chromium } = process.env.AJAR_PLAYWRIGHT ? require(process.env.AJAR_PLAYWRIGHT) : webRequire("playwright");
const base = process.env.PAD_PREVIEW_URL || "http://127.0.0.1:5176";
const production = process.env.PAD_PRODUCTION_URL;
const output = process.env.AJAR_SCREENSHOTS;

async function settled(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function main() {
  const browser = await chromium.launch({
    channel: process.env.AJAR_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${base}/?preview=workspace`);
    await page.locator(".pad-shell").waitFor();
    await page.evaluate(() => {
      localStorage.setItem("ajar.sidebar", "hidden");
      localStorage.setItem("pad.sidebar", "real-value-must-not-change");
    });
    await page.reload();
    await page.locator(".pad-shell").waitFor();
    assert.equal(await page.locator("#sidebar").isVisible(), true, "fixture uses in-memory preferences");
    assert.equal(await page.evaluate(() => localStorage.getItem("ajar.sidebar")), "hidden");
    assert.equal(await page.evaluate(() => localStorage.getItem("pad.sidebar")), "real-value-must-not-change");
    assert.equal(await page.locator("#preview-pane").isHidden(), true, "preview starts without a blank row");
    assert.equal(await page.locator("#status").getAttribute("role"), "status");

    const box = (selector) => page.locator(selector).boundingBox();
    const main = await box(".main");
    const initial = await box("#viewer-pane");
    assert(Math.abs(initial.height / (main.height - 8) - 0.6) < 0.02, "Pad editor defaults to 60%");
    const sidebar = page.locator("#sidebar-splitter");
    await sidebar.focus();
    const oldWidth = (await box("#sidebar")).width;
    await page.keyboard.press("ArrowRight");
    await settled(page);
    assert((await box("#sidebar")).width > oldWidth, "keyboard resizes Pad sidebar");
    const handle = await sidebar.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(700, handle.y + 10);
    await page.mouse.up();
    await settled(page);
    assert((await box("#sidebar")).width <= 384, "Pad sidebar maximum holds");
    await page.locator("#splitter").focus();
    const beforeSplit = (await box("#viewer-pane")).height;
    await page.keyboard.press("ArrowUp");
    await settled(page);
    assert((await box("#viewer-pane")).height < beforeSplit, "keyboard resizes Pad editor/terminal");

    for (const state of ["populated", "empty", "saving", "save-failure", "runtime-loading", "running", "disconnected"]) {
      await page.locator("#preview-scenario").selectOption(state);
      await settled(page);
      assert((await page.locator("#status").textContent()).trim().length > 0, `${state} has visible status`);
      assert.equal(await page.locator(".shell").count(), 1, `${state} keeps one shell`);
    }
    await page.locator("#preview-scenario").selectOption("running");
    const terminalHeight = (await box(".terminals")).height;
    const editorText = await page.locator("#editor").textContent();
    await page.locator("#preview").click();
    assert.equal(await page.locator("#preview-pane iframe").isVisible(), true, "server preview replaces the editor");
    assert.equal((await box(".terminals")).height, terminalHeight, "server preview keeps terminal height stable");
    assert.equal(await page.locator("#preview-pane iframe").getAttribute("sandbox"), "", "fixture preview has an isolated origin");
    await page.locator("#back-to-editor").click();
    assert.equal(await page.locator("#editor").isVisible(), true, "Back to editor restores Monaco region");
    assert.equal(await page.locator("#editor").textContent(), editorText, "preview switching retains editor state");
    assert.equal((await box(".terminals")).height, terminalHeight, "returning keeps terminal height stable");
    await page.locator("#preview-scenario").selectOption("populated");
    await page.locator("#run").click();
    assert.equal(await page.locator("#status").getAttribute("data-status"), "running");
    await page.locator("#share").click();
    assert.match(await page.locator("#status").textContent(), /simulated/);

    const themeColors = [];
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await settled(page);
      themeColors.push(await page.locator(".shell").evaluate((element) => getComputedStyle(element).backgroundColor));
    }
    assert.notEqual(themeColors[0], themeColors[1], "Pad applies the shared light and dark themes");

    for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await settled(page);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Pad has no page overflow at ${width}`);
      for (const id of ["side-toggle", "run", "share", "splitter"]) {
        const bounds = await box(`#${id}`);
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `${id} reachable at ${width}`);
      }
      if (width < 768) {
        const mainWidth = (await box(".main")).width;
        await page.getByRole("button", { name: "Files", exact: true }).click();
        assert.equal((await box(".main")).width, mainWidth, "Pad drawer does not compress tools");
        assert.equal(await page.locator("#sidebar").getAttribute("aria-modal"), "true");
        await page.getByRole("button", { name: "Close files", exact: true }).focus();
        await page.keyboard.press("Shift+Tab");
        assert(await page.evaluate(() => document.activeElement?.classList.contains("row")), "Pad drawer wraps focus");
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.activeElement?.id), "side-toggle");
      }
    }

    await page.setViewportSize({ width: 720, height: 450 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
    await settled(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Pad fits a 200%-equivalent viewport with larger text");
    for (const id of ["side-toggle", "run", "share", "splitter"]) {
      const bounds = await box(`#${id}`);
      assert(bounds && bounds.x + bounds.width <= 721 && bounds.y + bounds.height <= 451, `${id} fits with larger text`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    const keys = await page.evaluate(() => [...window.__padPreview.preferences.keys()]);
    assert(keys.every((key) => key.startsWith("pad.")), "Pad preview preferences are isolated");
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, "fixture registers no service worker");
    assert(!requests.some((url) => /\/api\/|\/ws(?:$|\?)|\/vendor\/wasmer|\/public\/packages\//.test(url)), "fixture makes no backend/runtime/package request");
    assert.deepEqual(errors, []);

    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        await settled(page);
        await page.screenshot({ path: path.join(output, `pad-workspace-${theme}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(output, "pad-workspace-mobile.png") });
    }

    if (production) {
      const built = await browser.newPage();
      await built.route("**/api/pad/**", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: false, seq: 0, files: {} }),
      }));
      await built.goto(`${production}/production-preview-query?preview=workspace`);
      await built.locator(".monaco-editor").waitFor();
      assert.equal(await built.locator("#preview-scenario").count(), 0, "production omits Pad fixture controls");
      await built.close();
    }
    console.log("Pad layout checks passed: shared shell, resize, four viewports, drawer focus, status fixtures, preference and network isolation.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

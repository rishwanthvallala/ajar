import { chromium } from "playwright";
const ORIGIN = "https://code.rishwanth.dev";
const name = `pip3-${Date.now()}`;
await fetch(`${ORIGIN}/api/pad/${name}`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ writes: [{ path: "use.py", content: "import six\nprint('six is', six.__version__)\n" }] }),
});
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${ORIGIN}/${name}`, { waitUntil: "networkidle" });
await page.locator(".xterm").first().click();
const rows = () => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");

// A marker can appear while the command is still running, and anything typed
// then goes to the command rather than the shell — which mangles the next line
// instead of failing, so it reads as a broken feature. Wait for the prompt.
const idle = async (timeout = 240_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const lines = (await rows()).split("\n").filter((l) => l.trim());
    if ((lines[lines.length - 1] ?? "").trim() === "$") return true;
    await page.waitForTimeout(1000);
  }
  return false;
};
async function run(cmd, marker, label) {
  await page.keyboard.type(cmd + "\n");
  await page.waitForTimeout(500);
  const finished = await idle();
  const text = await rows();
  const passed = finished && text.includes(marker);
  console.log(`  ${passed ? "ok  " : "FAIL"} ${label}`);
  return passed;
}
await idle(60_000);
let bad = 0;
if (!await run("pip install six 2>&1 | grep -o 'Successfully installed six-1.17.0'", "Successfully installed six-1.17.0", "pip install six, typed plainly")) bad++;
if (!await run("python3 use.py", "six is 1.17.0", "a script in the folder imports it")) bad++;
if (!await run("pip install requests 2>&1 | grep -c 'Successfully installed' | sed 's/^/REQOK=/'", "REQOK=1", "a package with dependencies")) bad++;
if (!await run("python3 -c \"import requests, six; print('BOTH=' + requests.__version__)\"", "BOTH=2.", "both import in one process")) bad++;
if (!await run("ls .deps | grep -c . | sed 's/^/ENTRIES=/'", "ENTRIES=", "the folder carries them")) bad++;
console.log((await rows()).split("\n").filter((l) => /ENTRIES=\d|BOTH=|REQOK=|six is/.test(l)).map((l) => "    | " + l.trim()).join("\n"));
await browser.close();
process.exit(bad ? 1 : 0);

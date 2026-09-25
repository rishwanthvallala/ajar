#!/usr/bin/env node
// The pad, measured as a visitor meets it: land, read for a moment, press Run.
//
//   node scripts/perf/pad-visit.mjs
//   COLD=0,5000,10000 WARM=3000,3000 PIP=1 node scripts/perf/pad-visit.mjs
//
// COLD lists first visits by how long the visitor reads before pressing Run,
// in ms, each from an empty profile; WARM lists return visits on the profile
// the last one left behind. PIP=1 also times `pip install six` on the first
// visit. ORIGIN points at another deployment; PROFILE moves the profile.
//
// Budget: a first visit fetches every runtime file once, and production allows
// 30 fetches of each file an hour per address — spent by everyone behind that
// address, including whoever uses the pad from it. Keep COLD short. Return
// visits fetch nothing and cost nothing.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, ms, record, stats } from "./common.mjs";

const ORIGIN = process.env.ORIGIN ?? "https://code.rishwanth.dev";
const PROFILE = process.env.PROFILE ?? join(tmpdir(), "ajar-perf-pad-profile");
const list = (v, fallback) => (v ?? fallback).split(",").filter(Boolean).map(Number);
const COLD = list(process.env.COLD, "5000");
const WARM = list(process.env.WARM, "3000,3000");

const idle = (page) => page.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 60_000 });

async function visit(label, readMs, { fresh, pip, interact }) {
  if (fresh) rmSync(PROFILE, { recursive: true, force: true });
  const out = { harness: "pad-visit", label, read_before_run_ms: readMs, cached: !fresh && existsSync(PROFILE) };
  const context = await chromium.launchPersistentContext(PROFILE, { headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const landed = performance.now();
    await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
    await page.locator(".monaco-editor").waitFor({ timeout: 30_000 });
    out.editor_visible_ms = ms(landed);
    const folder = await page.evaluate(() => location.pathname.slice(1));

    await page.waitForTimeout(readMs);
    const run = performance.now();
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("terminal")?.textContent?.includes("wrote 10 rows"),
      null, { timeout: 240_000, polling: "raf" });
    out.run_to_output_ms = ms(run);
    out.landing_to_output_ms = ms(landed);
    await idle(page);

    if (pip) {
      await page.click("#terminal");
      const t = performance.now();
      await page.keyboard.type("pip install six\n");
      await page.waitForFunction(() => /Successfully installed six|already satisfied: six/.test(
        document.getElementById("terminal")?.textContent ?? ""), null, { timeout: 300_000 });
      out.pip_install_six_ms = ms(t);
      await idle(page);
    }

    if (interact) {
      // A second Run, python already up.
      const again = performance.now();
      await page.click("#run");
      await page.waitForFunction(() => (document.getElementById("terminal")?.textContent?.match(/wrote 10 rows/g) ?? []).length >= 2,
        null, { timeout: 60_000, polling: "raf" });
      out.second_run_ms = ms(again);
      await idle(page);

      // Echo at the prompt, erased afterwards rather than run. Starting with
      // `#`, which the prompt does not contain, so the first key cannot match
      // text that was already on screen.
      await page.locator("#terminal .xterm-helper-textarea").focus();
      const echo = [];
      let typed = "";
      for (let i = 0; i < 30; i++) {
        typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
        const want = typed;
        const t = performance.now();
        await page.keyboard.type(want.at(-1));
        await page.waitForFunction((w) => (document.querySelector("#terminal .xterm-rows")?.innerText ?? "").includes(w),
          want, { timeout: 10_000, polling: "raf" });
        echo.push(performance.now() - t);
        await page.waitForTimeout(120);
      }
      for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
      out.shell_echo_ms = stats(echo);

      // A short command, from Enter to its output.
      const command = [];
      for (let i = 0; i < 3; i++) {
        const tag = `perf${i}x${Math.floor(Math.random() * 1e6)}`;
        await page.keyboard.type(`echo ${tag}-ok`);
        await page.waitForTimeout(150);
        const t = performance.now();
        await page.keyboard.press("Enter");
        await page.waitForFunction((t) => (document.querySelector("#terminal .xterm-rows")?.innerText ?? "")
          .split("\n").some((l) => l.trim() === `${t}-ok`), tag, { timeout: 20_000, polling: "raf" });
        command.push(performance.now() - t);
        await idle(page);
      }
      out.shell_command_ms = stats(command);

      // A line that is only a comment used to hang the shell until ctrl-c.
      // Asked of the shell itself — is it idle again — rather than inferred
      // from a command typed straight after, which raced the comment line and
      // reported a hang that was not there.
      await page.keyboard.type("# only a comment\n");
      await page.waitForTimeout(300); // a hung shell is still busy by now
      out.comment_line_finishes = await page.waitForFunction(() => window.__pad?.shellBusy() === false,
        null, { timeout: 15_000 }).then(() => true, () => false);
      if (out.comment_line_finishes) {
        await page.keyboard.type("echo after-comment-ok\n");
        out.shell_runs_after_comment = await page.waitForFunction(
          () => (document.querySelector("#terminal .xterm-rows")?.innerText ?? "").split("\n").some((l) => l.trim() === "after-comment-ok"),
          null, { timeout: 15_000 }).then(() => true, () => false);
        await idle(page);
      }

      // An edit in the editor, from the last key to the server having it.
      const token = `saved${Math.floor(Math.random() * 1e6)}`;
      await page.locator(".monaco-editor .view-lines").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(`\n# ${token}`);
      const typedAt = performance.now();
      for (;;) {
        const pad = await fetch(`${ORIGIN}/api/pad/${folder}`).then((r) => r.json());
        if (JSON.stringify(pad.files ?? {}).includes(token)) break;
        if (performance.now() - typedAt > 30_000) throw new Error("the edit never reached the server");
        await new Promise((r) => setTimeout(r, 50));
      }
      out.autosave_ms = ms(typedAt);
    }
  } catch (e) {
    out.error = String(e.message).split("\n")[0];
  } finally {
    await context.close();
  }
  record(out);
}

for (const [i, read] of COLD.entries()) {
  await visit(`first-visit-${i + 1}`, read, { fresh: true, pip: i === 0 && process.env.PIP === "1", interact: false });
}
for (const [i, read] of WARM.entries()) {
  await visit(`return-visit-${i + 1}`, read, { fresh: false, pip: false, interact: true });
}

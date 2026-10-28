const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const frame = value => Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(JSON.stringify(value))]);
const mainText = Array.from({ length: 400 }, (_, i) => `print(${i + 1})`).join('\n');
const files = {
  'main.py': { content: mainText, encoding: 'utf8', seq: 1 },
  'util.py': { content: 'value = 42\n', encoding: 'utf8', seq: 1 },
  'other/util.py': { content: 'value = 99\n', encoding: 'utf8', seq: 1 },
  'folder/a.py': { content: 'first = 1\n', encoding: 'utf8', seq: 1 },
  'folder/b.py': { content: 'second = 2\n', encoding: 'utf8', seq: 1 },
  'README.md': { content: '# Hello\n\n[Utility](util.py)\n', encoding: 'utf8', seq: 1 },
  'plot.png': { content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', encoding: 'base64', seq: 1 },
};
const editors = `window.monaco.editor.getEditors().filter(e => e.getDomNode()?.closest('.editor-group'))`;
const focusedEditor = `${editors}.find(e => e.getDomNode().closest('.editor-group').classList.contains('focused'))`;
async function run() {
  const browser = await chromium.launch({ channel: process.env.AJAR_BROWSER_CHANNEL || undefined, headless: true });
  try {
    for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
      const mod = platform === 'MacIntel' ? 'Meta' : 'Control';
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      await context.addInitScript(platform => Object.defineProperty(navigator, 'platform', { value: platform }), platform);
      const page = await context.newPage(), errors = [];
      const storedFiles = structuredClone(files); let seq = 1, wire;
      const writes = [];
      let releaseRuntime;
      const runtimeGate = new Promise(resolve => { releaseRuntime = resolve; });
      await page.route('**/*.wasm*', async route => { await runtimeGate; await route.abort().catch(() => {}); });
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/pad/**', route => {
        if (route.request().method() === 'PUT') writes.push(...(route.request().postDataJSON()?.writes ?? []));
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true, seq, files: storedFiles }) });
      });
      await page.route('**/packages/**', route => route.abort());
      await page.routeWebSocket('**/ws', ws => { wire = ws; ws.onMessage(data => {
        const raw = Buffer.from(data); if (raw[0] === 1 && JSON.parse(raw.subarray(9).toString()).t === 'hello') ws.send(frame({ t: 'welcome', participant_id: 2, participants: [] }));
      }); });
      await page.goto('http://127.0.0.1:5175/editor-groups-check');
      await page.waitForFunction(() => window.__pad?.docs().includes('main.py'));
      await page.locator('.editor-group .monaco-editor').waitFor();
      await page.locator('.editor-group.focused').getByRole('button', { name: /^Split right / }).click();
      await page.waitForFunction(() => window.monaco.editor.getEditors().filter(e => e.getModel()).length === 2);
      assert(await page.evaluate(`${editors}[0].getModel() === ${editors}[1].getModel()`), `${platform}: one shared model`);
      await page.evaluate(`${focusedEditor}.pushUndoStop(); ${focusedEditor}.executeEdits('test', [{range: new window.monaco.Range(1,1,1,1), text: '# once\\n'}])`);
      await page.waitForFunction(() => window.__pad.text('main.py').startsWith('# once\n'));
      await page.evaluate(`${focusedEditor}.pushUndoStop(); ${focusedEditor}.getModel().undo()`);
      await page.waitForFunction(() => !window.__pad.text('main.py').includes('# once'));
      await page.evaluate(`${focusedEditor}.getModel().redo()`);
      await page.waitForFunction(() => window.__pad.text('main.py').startsWith('# once\n'));
      assert.equal(await page.evaluate(`${editors}[0].getModel().getValue().split('# once').length - 1`), 1, 'one edit, not two');
      await page.evaluate(`${editors}[0].setPosition({lineNumber: 250,column:1}); ${editors}[1].setPosition({lineNumber:20,column:1});`);
      const first = page.locator('.editor-group').nth(0), second = page.locator('.editor-group').nth(1);
      await first.getByRole('tab', { name: 'main.py', exact: true }).click();
      assert.equal(await page.evaluate(`${focusedEditor}.getPosition().lineNumber`), 250, 'first group retains its cursor');
      await second.getByRole('tab', { name: 'main.py', exact: true }).click();
      assert.equal(await page.evaluate(`${focusedEditor}.getPosition().lineNumber`), 20, 'second group retains its cursor');
      await page.locator('#files .row.file[data-path="util.py"]').click();
      await page.waitForFunction(() => window.__pad.active() === 'util.py');
      assert.equal(await first.getByRole('tab').count(), 1); assert.equal(await second.getByRole('tab').count(), 2);
      if (platform === 'MacIntel') {
        for (let i = 0; i < 100 && !writes.some(w => w.path === 'main.py'); i++) await page.waitForTimeout(25);
        assert(writes.some(w => w.path === 'main.py'), 'the first autosave completes before the second edit');
        await page.evaluate(`${focusedEditor}.executeEdits('test', [{range:new window.monaco.Range(1,1,1,1),text:'# second\\n'}])`);
        for (let i = 0; i < 100 && !writes.some(w => w.path === 'util.py' && w.content?.includes('# second')); i++) await page.waitForTimeout(25);
        assert(writes.some(w => w.path === 'main.py'), 'first file autosaves while runtime downloads are held');
        assert(writes.some(w => w.path === 'util.py' && w.content?.includes('# second')), 'the next file autosaves without waiting for the runtime');
      }
      await page.locator('.editor-group.focused [role="tab"][aria-selected="true"]').focus();
      await page.keyboard.press('Control+PageUp');
      assert.equal(await page.evaluate(() => window.__pad.active()), 'main.py', 'previous tab shortcut');
      await page.keyboard.press('Control+PageDown');
      assert.equal(await page.evaluate(() => window.__pad.active()), 'util.py', 'next tab shortcut');
      await page.keyboard.press(`${mod}+1`);
      assert.equal(await page.locator('.editor-group.focused').getAttribute('data-group'), await first.getAttribute('data-group'), 'focus group shortcut');
      await page.keyboard.press(`${mod}+2`);
      await page.keyboard.press(`${mod}+Backslash`);
      await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 3);
      await page.locator('.editor-group.focused [role="tab"][aria-selected="true"]').focus();
      await page.keyboard.press(`${mod}+w`);
      assert.equal(await page.locator('.editor-group').count(), 2, `${platform}: close shortcut collapses empty group`);
      await page.locator('#files .row.file[data-path="README.md"]').click();
      await page.locator('#markdown-view').click();
      await page.locator('.editor-group.focused .md-view h1').waitFor();
      assert.equal(await first.locator('.md-view').isVisible(), false, 'Markdown belongs to its group');
      await first.getByRole('tab', {name:'main.py',exact:true}).click();
      await page.locator('#files .row.file[data-path="README.md"]').click();
      assert.equal(await first.locator('.md-view').isVisible(), false, 'the same Markdown file can show source in one group');
      assert.equal(await second.locator('.md-view').isVisible(), true, 'and preview in another');
      await first.getByRole('button', {name:'Close README.md',exact:true}).click();
      await second.getByRole('tab', {name:'README.md',exact:true}).click();
      await page.locator('#files .row.file[data-path="plot.png"]').click();
      await page.locator('.editor-group.focused .image-view img').waitFor({ state: 'visible' });
      assert.equal(await first.locator('.monaco-editor').isVisible(), true, 'image does not replace the other group');
      assert.equal(await page.locator('#highlight-toggle').isVisible(), false, 'image focus hides Colours');
      await first.getByRole('tab', { name: 'main.py', exact: true }).click();
      assert.equal(await page.locator('#highlight-toggle').isVisible(), true, 'focusing an existing text pane restores Colours');
      assert.equal(await page.locator('#format-file').isVisible(), true, 'focusing an existing text pane restores Format');
      assert.equal(await page.locator('.editor-tools').isVisible(), true, 'text focus restores the shared tools, including available suggestions');
      assert.equal(await page.locator('#back-to-editor').isVisible(), false, 'text focus hides Back to editor');
      await second.getByRole('tab', { name: 'plot.png', exact: true }).click();
      assert.equal(await page.locator('#highlight-toggle').isVisible(), false, 'returning to the image restores image controls');
      await page.locator('.editor-group.focused').getByRole('tab', { name: 'main.py', exact: true }).click();
      await page.locator('.editor-group.focused').getByRole('button', { name: 'Editor group actions' }).click();
      await page.getByRole('menuitem', { name: /^Split down / }).click();
      assert.equal(await page.locator('.editor-group').count(), 3);
      await page.locator('.editor-group-divider').first().focus();
      const before = await page.locator('.editor-group-divider').first().getAttribute('aria-valuenow');
      await page.keyboard.press('ArrowRight');
      assert.notEqual(await page.locator('.editor-group-divider').first().getAttribute('aria-valuenow'), before, 'keyboard resizes divider');
      const handle = await page.locator('.editor-group-divider').first().boundingBox();
      const pointerBefore = await page.locator('.editor-group-divider').first().getAttribute('aria-valuenow');
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 10); await page.mouse.down();
      await page.mouse.move(handle.x + 80, handle.y + 10); await page.mouse.up();
      assert.notEqual(await page.locator('.editor-group-divider').first().getAttribute('aria-valuenow'), pointerBefore, 'pointer resizes divider');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('.shell').classList.contains('narrow'));
      assert.equal(await page.locator('.editor-group:visible').count(), 1);
      assert((await page.locator('.editor-group:visible').boundingBox()).width >= 389, 'phone group uses the full editor width');
      await page.locator('.editor-group-switcher').selectOption({ index: 0 });
      assert.equal(await page.locator('.editor-group:visible').count(), 1);
      assert.equal(await page.locator('.editor-group:visible').getAttribute('data-group'), await first.getAttribute('data-group'));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForFunction(() => !document.querySelector('.shell').classList.contains('narrow'));
      assert.equal(await page.locator('.editor-group:visible').count(), 3);
      await page.evaluate(`${editors}[0].setPosition({lineNumber: 200,column:1}); ${editors}[0].revealLineInCenter(200);`);
      await page.reload();
      await page.waitForFunction(() => window.monaco?.editor.getEditors().filter(e => e.getModel()).length === 3);
      assert.equal(await page.locator('.editor-group').count(), 3, 'groups restore after reload');
      assert.equal(await page.evaluate(`${editors}.find(e => e.getDomNode().closest('.editor-group') === document.querySelector('.editor-group')).getPosition().lineNumber`), 200, 'group cursor restores after reload');
      assert.equal(await page.locator('.editor-group').nth(1).getByRole('tab').count(), 4, 'tabs restore after reload');
      if (process.env.AJAR_SCREENSHOTS && platform === 'MacIntel') {
        fs.mkdirSync(process.env.AJAR_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AJAR_SCREENSHOTS, 'editor-groups-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => document.querySelector('.shell').classList.contains('narrow'));
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(process.env.AJAR_SCREENSHOTS, 'editor-groups-mobile.png') });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForFunction(() => !document.querySelector('.shell').classList.contains('narrow'));
      await second.getByRole('tab', {name:'README.md',exact:true}).click();
      await second.locator('.md-view h1').waitFor();
      await second.getByRole('tab', {name:'main.py',exact:true}).click();
      // Move and reorder with native HTML drag events, then close through the menu.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForFunction(() => !document.querySelector('.shell').classList.contains('narrow'));
      const source = page.locator('.editor-group').nth(1).locator('.editor-tab[data-path="util.py"]');
      await source.dragTo(first.locator('.editor-tab[data-path="main.py"]'));
      assert.equal(await first.getByRole('tab').count(), 2, 'drag moves a tab to another group');
      await first.locator('.editor-tab[data-path="util.py"]').dragTo(first.locator('.editor-tab[data-path="main.py"]'));
      assert.equal(await first.getByRole('tab').first().textContent(), 'util.py', 'drag reorders tabs');
      await first.getByRole('button', { name: 'Editor group actions' }).click();
      await page.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click();
      assert.equal(await first.getByRole('tab').count(), 1);
      if (!(await page.locator('#files .row.file[data-path="other/util.py"]').isVisible())) await page.locator('#files .row.dir[data-path="other"]').click();
      await page.locator('#files .row.file[data-path="other/util.py"]').click();
      assert((await first.getByRole('tab', {name:'other/util.py',exact:true}).textContent()).includes('other'), 'duplicate filenames include their folder');
      await first.getByRole('tab', {name:'util.py',exact:true}).click();
      if (platform === 'MacIntel') {
        await page.evaluate(`${focusedEditor}.executeEdits('test', [{range: new window.monaco.Range(1,1,1,1), text:'# retained\\n'}])`);
        delete storedFiles['util.py']; seq++;
        wire.send(Buffer.concat([Buffer.from([3,0,0,0,0,0,0,0,0]), Buffer.from(JSON.stringify({t:'moved',seq}))]));
        await first.getByRole('button', {name:'Save local copy',exact:true}).waitFor();
        assert(await page.evaluate(`window.__pad.text('util.py').includes('# retained')`), 'deleted file keeps pending typing');
        assert(await page.evaluate(`!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))`), 'retained file protects against leaving');
        assert(await page.evaluate(`${focusedEditor}.getOption(window.monaco.editor.EditorOption.readOnly)`), 'retained file is read-only');
        if (!(await page.locator('#files .row.file[data-path="folder/a.py"]').isVisible())) await page.locator('#files .row.dir[data-path="folder"]').click();
        await page.locator('#files .row.file[data-path="folder/a.py"]').click();
        await second.getByRole('tab', {name:'main.py',exact:true}).click();
        await page.locator('#files .row.file[data-path="folder/b.py"]').click();
        const count = await page.locator('.editor-group').count();
        for (const leaf of ['a.py', 'b.py']) {
          storedFiles[`moved/${leaf}`] = storedFiles[`folder/${leaf}`];
          delete storedFiles[`folder/${leaf}`];
        }
        seq++;
        wire.send(Buffer.concat([Buffer.from([3,0,0,0,0,0,0,0,0]), Buffer.from(JSON.stringify({t:'moved',seq}))]));
        await first.getByRole('tab', {name:'moved/a.py',exact:true}).waitFor();
        await second.getByRole('tab', {name:'moved/b.py',exact:true}).waitFor();
        assert.equal(await page.locator('.editor-group').count(), count, 'remote folder moves preserve all panes');
      }
      if (platform === 'Linux x86_64') {
        while (await page.getByRole('tab').count()) {
          const populated = page.locator('.editor-group').filter({has: page.getByRole('tab')}).first();
          await populated.getByRole('button', {name:'Editor group actions'}).click();
          await page.getByRole('menuitem', {name:'Close all tabs',exact:true}).click();
        }
        assert.equal(await page.locator('.editor-group').count(), 1);
        await page.reload();
        await page.waitForFunction(() => window.__pad && window.monaco);
        assert.equal(await page.getByRole('tab').count(), 0, 'an intentionally empty layout stays empty after reload');
      }
      assert.deepEqual(errors, [], `${platform}: no editor errors`);
      releaseRuntime();
      await context.close();
      console.log(`Editor groups: ${platform} tabs, splits, shared model, shortcuts, previews, resizing, mobile and restoration.`);
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

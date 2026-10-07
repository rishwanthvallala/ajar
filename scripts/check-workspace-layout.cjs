// Start the web dev server first. See docs/dev/testing.md.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.resolve(__dirname, '../web/package.json'));
const { chromium } = process.env.AJAR_PLAYWRIGHT ? require(process.env.AJAR_PLAYWRIGHT) : webRequire('playwright');
const base = process.env.AJAR_PREVIEW_URL || 'http://127.0.0.1:5173';
const output = process.env.AJAR_SCREENSHOTS;
let browser;

async function main() {
  browser = await chromium.launch({ channel: process.env.AJAR_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], sockets = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/ws') sockets.push(socket.url()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem('ajar.sidebar', 'hidden'));
  await page.goto(`${base}/?preview=workspace`);
  await page.locator('.monaco-editor').waitFor();
  await page.waitForFunction(() => document.querySelector('#viewer-title')?.textContent === 'src/main.ts');
  const box = selector => page.locator(selector).boundingBox();
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settled();
  assert.equal(await page.locator('#sidebar').isVisible(), true, 'preview does not read real layout preferences');
  assert.equal(await page.evaluate(() => localStorage.getItem('ajar.sidebar')), 'hidden');
  const initial = await box('#viewer-pane'), main = await box('.main');
  assert(Math.abs(initial.height / (main.height - 8) - 0.6) < 0.02, 'editor defaults to 60%');
  await page.getByRole('button', { name: 'Close file', exact: true }).click();
  assert(await page.locator('#editor-empty').isVisible());
  assert(Math.abs((await box('#viewer-pane')).height - initial.height) < 1, 'close preserves editor height');
  assert(await page.locator('.xterm').isVisible(), 'close preserves terminal');
  await page.getByRole('button', { name: 'src/greet.ts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#viewer-title')?.textContent === 'src/greet.ts');

  const separator = page.locator('#sidebar-splitter');
  await separator.focus(); const before = await box('#sidebar');
  await page.keyboard.press('ArrowRight'); await settled();
  assert((await box('#sidebar')).width > before.width);
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(700, handle.y + 10); await page.mouse.up(); await settled();
  assert((await box('#sidebar')).width <= 384, 'sidebar maximum');
  await page.locator('#splitter').focus(); const oldEditor = await box('#viewer-pane');
  await page.keyboard.press('ArrowUp'); await settled();
  assert((await box('#viewer-pane')).height < oldEditor.height);

  // The theme: System, then Light, then Dark, then System again — on the page,
  // the editor and the terminal at once. A choice beats the OS; System follows it.
  const themed = async () => {
    await settled();
    return page.evaluate(() => ({
      attr: document.documentElement.dataset.theme ?? null,
      label: document.querySelector('#theme-toggle').getAttribute('aria-label'),
      shell: getComputedStyle(document.querySelector('.shell')).backgroundColor,
      editorDark: document.querySelector('.monaco-editor').classList.contains('vs-dark'),
      // xterm 6 paints its theme here; .xterm-viewport stays black.
      terminal: getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor,
    }));
  };
  await page.emulateMedia({ colorScheme: 'light' });
  const system = await themed();
  assert.deepEqual([system.attr, system.label, system.editorDark], [null, 'Theme: System', false], 'theme starts on System');
  await page.locator('#theme-toggle').click();
  const light = await themed();
  assert.deepEqual([light.attr, light.label, light.editorDark], ['light', 'Theme: Light', false]);
  await page.locator('#theme-toggle').click();
  const dark = await themed();
  assert.deepEqual([dark.attr, dark.label, dark.editorDark], ['dark', 'Theme: Dark', true], 'Dark reaches the editor');
  assert.notEqual(dark.shell, light.shell, 'Dark changes the page colours');
  assert.notEqual(dark.terminal, light.terminal, 'Dark reaches the terminal');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal((await themed()).editorDark, true, 'a chosen theme beats the OS');
  await page.locator('#theme-toggle').click();
  assert.deepEqual([(await themed()).attr, (await themed()).editorDark], [null, false], 'System follows a light OS');
  await page.emulateMedia({ colorScheme: 'dark' });
  const followed = await themed();
  assert.equal(followed.editorDark, true, 'System follows the OS turning dark');
  assert.equal(followed.shell, dark.shell, 'System dark is the same dark');
  await page.emulateMedia({ colorScheme: 'light' }); await settled();
  assert.equal(await page.evaluate(() => localStorage.getItem('ajar.theme')), null, 'preview does not write the live theme');

  // Colours off is plain text; on is the file's language again.
  const tokenKinds = () => page.evaluate(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size);
  await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size >= 3);
  assert.equal(await page.locator('#highlight-toggle').getAttribute('aria-pressed'), 'true');
  await page.locator('#highlight-toggle').click();
  await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size === 1).catch(() => {});
  assert.equal(await tokenKinds(), 1, 'Colours off shows plain text');
  assert.equal(await page.locator('#highlight-toggle').getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'src/main.ts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#viewer-title')?.textContent === 'src/main.ts');
  await settled();
  assert.equal(await tokenKinds(), 1, 'a file opened while Colours is off is plain text too');
  await page.locator('#highlight-toggle').click();
  await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size >= 3);
  await page.getByRole('button', { name: 'src/greet.ts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#viewer-title')?.textContent === 'src/greet.ts');

  for (const [width, height] of [[1440, 900], [1024, 768], [640, 360], [390, 844]]) {
    await page.setViewportSize({ width, height }); await settled();
    await page.evaluate(() => {
      document.querySelector('#workspace').textContent = 'a-very-long-workspace-name-with-several-projects-and-environments';
      document.querySelector('#viewer-title').textContent = 'src/workspace-layout-accessibility-and-responsive-navigation.ts';
      document.querySelector('#people').innerHTML = '<span class="person">Participant with a long display name</span>'.repeat(8);
    });
    await settled();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`);
    for (const id of ['side-toggle', 'theme-toggle', 'highlight-toggle', 'close-file', 'new-terminal', 'split']) {
      const bounds = await box(`#${id}`);
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height, `${id} reachable at ${width}`);
    }
    if (width < 768) {
      const mainWidth = (await box('.main')).width;
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      assert.equal((await box('.main')).width, mainWidth, 'drawer does not compress content');
      assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), 'true');
      await page.getByRole('button', { name: 'Close files', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      assert(await page.evaluate(() => document.activeElement?.classList.contains('tree-row')), 'drawer focus wraps backwards');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'drawer-close');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'side-toggle');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'src/main.ts', exact: true }).click();
      assert.equal(await page.locator('#sidebar').isVisible(), false);
      await page.waitForFunction(() => document.activeElement?.closest('.monaco-editor'));
    }
  }
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 }); await settled();
  assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), null);
  assert.equal(await page.locator('.main').evaluate(el => el.inert), false);

  // Repeated fixture remounts exercise observer/listener disposal.
  for (const state of ['empty', 'disconnected', 'populated', 'empty']) {
    await page.locator('#preview-scenario').selectOption(state); await settled();
    assert.equal(await page.locator('.shell').count(), 1);
  }
  assert(await page.locator('#editor-empty').isVisible());
  assert(await page.locator('#empty').isVisible());
  assert.equal(await page.evaluate(() => localStorage.getItem('ajar.sidebar')), 'hidden', 'preview does not write live preferences');
  assert.equal(sockets.length, 0, 'preview opens no session socket');

  // Fresh empty fixture proves Monaco remains lazy until a file is selected.
  const lazyPage = await browser.newPage();
  const lazyRequests = [];
  await lazyPage.route('**/src/workspace-preview.ts*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('let scenario = "populated"', 'let scenario = "empty"');
    await route.fulfill({ response, body });
  });
  lazyPage.on('request', request => lazyRequests.push(request.url()));
  await lazyPage.goto(`${base}/?preview=workspace`);
  await lazyPage.locator('#editor-empty').waitFor();
  assert(!lazyRequests.some(url => /\/src\/viewer\.ts|monaco-editor/.test(url)), 'empty editor does not load Monaco');
  await lazyPage.close();

  // A table and a language ajar used to show as plain text. The CSV tokenizer
  // is fetched when a CSV is opened, not before.
  const tablePage = await browser.newPage();
  const tableRequests = [];
  tablePage.on('pageerror', error => errors.push(error.message));
  tablePage.on('request', request => tableRequests.push(request.url()));
  await tablePage.route('**/src/workspace-preview.ts*', async route => {
    const response = await route.fetch();
    const extra = JSON.stringify({ 'data.csv': 'id,name,city\n1,"Lee, A",Oslo\n2,Kim,Lima\n', 'script.lua': 'local n = 42 -- answer\nprint("n", n)\n' });
    const body = (await response.text()).replace('"src/main.ts":', `${extra.slice(1, -1)}, "src/main.ts":`);
    await route.fulfill({ response, body });
  });
  await tablePage.goto(`${base}/?preview=workspace`);
  await tablePage.locator('.monaco-editor').waitFor();
  const tableKinds = () => tablePage.evaluate(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size);
  await tablePage.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size >= 3);
  assert(!tableRequests.some(url => /delimited-tokens/.test(url)), 'no CSV tokenizer before a CSV is opened');
  for (const [file, kinds] of [['script.lua', 3], ['data.csv', 4]]) {
    await tablePage.getByRole('button', { name: file, exact: true }).click();
    await tablePage.waitForFunction(name => document.querySelector('#viewer-title')?.textContent === name, file);
    await tablePage.waitForFunction(n => new Set([...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')].map(s => s.className)).size >= n, kinds, { timeout: 10_000 }).catch(() => {});
    assert((await tableKinds()) >= kinds, `${file} is coloured: ${await tableKinds()} kinds of token`);
  }
  assert(tableRequests.some(url => /delimited-tokens/.test(url)), 'the CSV tokenizer arrives with the first CSV');
  await tablePage.close();

  // Exercise the shared controller with actual storage restoration/failure.
  await page.evaluate(async () => {
    const { Workspace } = await import('/src/workspace.ts');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;z-index:100'; document.body.appendChild(host);
    const data = new Map([['ajar.split', '0.7'], ['ajar.sidebarWidth', '18'], ['ajar.sidebar', 'shown']]);
    const w = new Workspace(host, 'stored', { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (Math.abs(Number(w.el('splitter').getAttribute('aria-valuenow')) - 70) > 1) throw Error('saved split lost');
    if (Number(w.el('sidebar-splitter').getAttribute('aria-valuenow')) !== 18) throw Error('saved width lost');
    w.dispose();
    const denied = new Workspace(host, 'denied', { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
    denied.el('side-toggle').click(); denied.el('side-toggle').click(); denied.dispose();
    const bad = new Workspace(host, 'invalid', { getItem: () => 'NaN', setItem() {} });
    if (bad.el('splitter').getAttribute('aria-valuenow') !== '60') throw Error('invalid preference fallback');
    bad.dispose(); host.remove();
  });

  await checkSession();
  await checkVersionMismatch();

  // A 1440x900 display at 200% browser zoom exposes a 720x450 CSS viewport.
  const zoomPage = await browser.newPage({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  zoomPage.on('pageerror', error => errors.push(error.message));
  await zoomPage.goto(`${base}/?preview=workspace`);
  await zoomPage.locator('.monaco-editor').waitFor();
  for (const theme of ['light', 'dark']) {
    await zoomPage.emulateMedia({ colorScheme: theme });
    for (const state of ['populated', 'empty', 'disconnected']) {
      await zoomPage.locator('#preview-scenario').selectOption(state);
      await zoomPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await zoomPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200%-equivalent layout has no horizontal overflow');
      for (const id of ['side-toggle', 'theme-toggle', 'new-terminal', 'split']) {
        const rect = await zoomPage.locator(`#${id}`).boundingBox();
        assert(rect && rect.x + rect.width <= 721 && rect.y + rect.height <= 450, `${id} fits zoomed layout`);
      }
    }
  }
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await zoomPage.screenshot({ path: path.join(output, 'workspace-zoom-200.png') });
  }
  await zoomPage.close();

  if (process.env.AJAR_PRODUCTION_URL) {
    const production = await browser.newPage();
    await production.goto(`${process.env.AJAR_PRODUCTION_URL}/?preview=workspace`);
    await production.locator('.landing').waitFor();
    assert.equal(await production.locator('#preview-bar').count(), 0, 'production has no preview entry point');
    await production.close();
  }

  if (output) {
    fs.mkdirSync(output, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('#preview-scenario').selectOption('populated');
      await page.locator('.monaco-editor').waitFor(); await settled();
      await page.screenshot({ path: path.join(output, `workspace-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 }); await settled();
    await page.screenshot({ path: path.join(output, 'workspace-mobile.png') });
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('Workspace layout checks passed: editor lifecycle, pointer/keyboard resize, four viewport sizes, drawer focus, preferences, preview isolation, lazy loading, and disposal.');
}

async function checkVersionMismatch() {
  // The one thing a version mismatch must not do is nothing.
  //
  // Before the guard, a guest joining an agent that predates the direction
  // byte got a session that connected, drew a terminal, and silently dropped
  // every frame in both directions — indistinguishable from the product being
  // broken. This asserts the guest is told, and told what to run.
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const frame = (channel, data) => {
    const body = Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(9); header[0] = channel; header.writeUInt32LE(0, 1);
    return Buffer.concat([header, body]);
  };
  await page.routeWebSocket('**/ws', ws => {
    ws.onMessage(data => {
      const buffer = Buffer.from(data);
      if (buffer.readUInt32LE(1)) return;
      const msg = JSON.parse(buffer.subarray(9).toString());
      // 0 is a current relay reporting an agent from before versioning.
      if (msg.t === 'hello') {
        ws.send(frame(1, { t: 'welcome', participant_id: 2, participants: [], host_protocol: 0 }));
        ws.send(frame(3, { t: 'tree', entries: [{ path: 'main.ts', kind: 'file', size: 40 }] }));
      }
    });
  });
  await page.goto(`${base}/j/version-check`);
  await page.locator('#name').fill('Version check');
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  await page.getByRole('heading', { name: /older ajar/i }).waitFor({ timeout: 15000 });
  const body = await page.locator('.centered').innerText();
  assert(/install\.sh/.test(body), 'the mismatch notice names the command that fixes it');
  // And it must not pretend to be a working session underneath the notice.
  assert(
    !(await page.getByRole('button', { name: 'main.ts', exact: true }).isVisible()),
    'a mismatched session does not also render a file tree',
  );
  await page.close();
}

async function checkSession() {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [], sent = [];
  page.on('pageerror', error => errors.push(error.message));
  let wire;
  // Read out of web/src/proto.ts so this fixture cannot drift into claiming a
  // version the client no longer speaks.
  const PROTOCOL_VERSION = Number(
    /export const PROTOCOL_VERSION = (\d+)/.exec(
      fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'proto.ts'), 'utf8'),
    )[1],
  );

  const frame = (channel, data, stream = 0) => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(9); header[0] = channel; header.writeUInt32LE(stream, 1);
    return Buffer.concat([header, body]);
  };
  await page.routeWebSocket('**/ws', ws => {
    wire = ws;
    ws.onMessage(data => {
      const buffer = Buffer.from(data), channel = buffer[0], stream = buffer.readUInt32LE(1);
      if (stream) { sent.push({ channel, stream, bytes: buffer.subarray(9) }); return; }
      const msg = JSON.parse(buffer.subarray(9).toString()); sent.push({ channel, ...msg });
      if (msg.t === 'hello') {
        // host_protocol models a current relay. Absent would exercise the
        // "cannot tell" path, which is not what this check is about.
        ws.send(frame(1, { t: 'welcome', participant_id: 2, participants: [], host_protocol: PROTOCOL_VERSION }));
        ws.send(frame(3, { t: 'tree', entries: [{ path: 'main.ts', kind: 'file', size: 40 }] }));
      }
      if (channel === 2 && msg.t === 'open') {
        ws.send(frame(2, { t: 'opened', pty_id: 1, cols: 80, rows: 24, opened_by: 2 }));
        ws.send(frame(2, Buffer.from('Session fixture terminal\r\n'), 1));
      }
      // File replies are controlled below to test close/loading races.
    });
  });
  let releaseViewer;
  const viewerGate = new Promise(resolve => { releaseViewer = resolve; });
  await page.route('**/src/viewer.ts*', async route => { await viewerGate; await route.continue(); });
  await page.goto(`${base}/j/layout-check`);
  await page.locator('#name').fill('Layout check');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: 'main.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'main.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Close file', exact: true }).click();
  releaseViewer();
  await page.evaluate(() => import('/src/viewer.ts'));
  assert(await page.locator('#editor-empty').isVisible(), 'closing during lazy load stays empty');
  assert(!sent.some(msg => msg.channel === 5 && msg.t === 'open'), 'cancelled selection sends no open request');
  await page.getByRole('button', { name: 'main.ts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#viewer')?.getAttribute('aria-busy') !== 'true');
  // Deliver an editable document using the actual Yjs wire format.
  const Y = webRequire('yjs'), doc = new Y.Doc(); doc.getText('content').insert(0, 'const answer = 42;\n');
  wire.send(frame(5, { t: 'opened', doc_id: 11, path: 'main.ts' }));
  wire.send(frame(5, Buffer.concat([Buffer.from([1]), Buffer.from(Y.encodeStateAsUpdate(doc))]), 11));
  await page.locator('.monaco-editor').waitFor();
  await page.waitForFunction(() => document.querySelector('.view-lines')?.textContent?.includes('answer'));
  // Read-only reaches the editor as well as the terminals. The host drops a
  // guest's edits while it is on, so the editor must not take keystrokes the
  // file will not keep.
  const edits = () => sent.filter(m => m.channel === 5 && m.stream === 11 && m.bytes?.[0] === 1).length;
  const lines = () => page.locator('.view-lines').textContent();
  // A flip either way reopens the file from the host's copy, since edits the
  // host refused meanwhile would otherwise leave the page out of step. This
  // stands in for the host: it answers the reopen with the document again.
  const opens = () => sent.filter(m => m.channel === 5 && m.t === 'open').length;
  const answerReopen = async (before) => {
    for (let i = 0; i < 100 && opens() <= before; i++) await new Promise(r => setTimeout(r, 50));
    assert(opens() > before, 'a read-only flip reopens the file');
    wire.send(frame(5, { t: 'opened', doc_id: 11, path: 'main.ts' }));
    wire.send(frame(5, Buffer.concat([Buffer.from([1]), Buffer.from(Y.encodeStateAsUpdate(doc))]), 11));
  };
  let opensBefore = opens();
  wire.send(frame(2, { t: 'read_only', read_only: true }));
  await page.waitForFunction(() => document.getElementById('readonly')?.hidden === false);
  await answerReopen(opensBefore);
  await page.waitForFunction(() => document.getElementById('viewer')?.dataset.editing === 'main.ts');
  const editsBefore = edits();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('xyz');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(!(await lines()).includes('xyz'), 'a read-only file does not take typing');
  assert.equal(edits(), editsBefore, 'and sends no edit');
  opensBefore = opens();
  wire.send(frame(2, { t: 'read_only', read_only: false }));
  await page.waitForFunction(() => document.getElementById('readonly')?.hidden === true);
  await answerReopen(opensBefore);
  await page.waitForFunction(() => document.getElementById('viewer')?.dataset.editing === 'main.ts');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('qq');
  await page.waitForFunction(() => document.querySelector('.view-lines')?.textContent?.includes('qq'));
  assert(edits() > editsBefore, 'editing resumes when read-only ends');
  // Other people's cursors arrive as their own awareness state, unchecked. An
  // id is written into a stylesheet, so one that is not a number must draw
  // nothing — not rewrite the page — and an honest cursor beside it still draws.
  const { Awareness, encodeAwarenessUpdate } = webRequire('y-protocols/awareness');
  const cursorFrom = (user) => {
    const d = new Y.Doc(), a = new Awareness(d);
    a.setLocalState({ user, cursor: { index: 0, length: 0 } });
    const bytes = encodeAwarenessUpdate(a, [d.clientID]);
    // Awareness runs an interval until destroyed, which keeps node alive
    // after everything else has finished — the run printed "passed" and hung.
    a.destroy(); d.destroy();
    return frame(5, Buffer.concat([Buffer.from([2]), Buffer.from(bytes)]), 11);
  };
  wire.send(cursorFrom({ id: '7-caret {} body { display: none } .x', name: 'mallory' }));
  wire.send(cursorFrom({ id: 9, name: 7 }));
  await page.waitForFunction(() => document.querySelector('.remote-9-caret'), null, { timeout: 5000 }).catch(() => {});
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).display), 'none', 'a cursor id cannot write the stylesheet');
  // The attacker's own text, not any `display: none` — the page's stylesheets
  // have those legitimately.
  assert(!(await page.evaluate(() => [...document.querySelectorAll('style')].some(s => s.textContent.includes('body { display: none }')))), 'nothing of it reached a style element');
  assert(await page.locator('.remote-9-caret').count() > 0, 'an honest cursor beside it still draws, whatever its name');
  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  await page.locator('.xterm').waitFor();
  await page.getByRole('button', { name: 'Close file', exact: true }).click();
  wire.send(frame(3, { t: 'content', path: 'main.ts', text: 'late content', binary: false, truncated: false }));
  wire.send(frame(5, { t: 'opened', doc_id: 12, path: 'main.ts' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(await page.locator('#editor-empty').isVisible(), 'late content cannot reopen a closed file');
  assert(await page.locator('.xterm').isVisible(), 'terminal remains mounted');
  await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('pwd');
  await page.locator('#splitter').focus(); await page.keyboard.press('ArrowDown');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(sent.some(msg => msg.channel === 5 && msg.t === 'close' && msg.doc_id === 11), 'document detached');
  assert(sent.some(msg => msg.channel === 2 && msg.stream === 1), 'terminal input binding preserved');
  assert(sent.some(msg => msg.channel === 2 && msg.t === 'resize'), 'terminal resize binding preserved');
  wire.send(frame(1, { t: 'closed', reason: 'Layout fixture finished' }));
  await page.getByRole('heading', { name: 'Session ended' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(errors, [], 'session mounting/disposal has no uncaught errors');
  doc.destroy(); await page.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => browser?.close());

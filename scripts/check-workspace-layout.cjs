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

  for (const [width, height] of [[1440, 900], [1024, 768], [640, 360], [390, 844]]) {
    await page.setViewportSize({ width, height }); await settled();
    await page.evaluate(() => {
      document.querySelector('#workspace').textContent = 'a-very-long-workspace-name-with-several-projects-and-environments';
      document.querySelector('#viewer-title').textContent = 'src/workspace-layout-accessibility-and-responsive-navigation.ts';
      document.querySelector('#people').innerHTML = '<span class="person">Participant with a long display name</span>'.repeat(8);
    });
    await settled();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`);
    for (const id of ['side-toggle', 'close-file', 'new-terminal', 'split']) {
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
      for (const id of ['side-toggle', 'new-terminal', 'split']) {
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

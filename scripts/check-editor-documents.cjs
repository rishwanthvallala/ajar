const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Y = require('yjs');
const key = crypto.randomBytes(32);
const sealed = new Set([2,3,4,5]);
function frame(channel, value, stream = 0) {
  const head = Buffer.alloc(9); head[0] = channel; head.writeUInt32LE(stream, 1);
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  if (!sealed.has(channel)) return Buffer.concat([head, body]);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([Buffer.from([0xa1]), head]));
  return Buffer.concat([head, nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}
function unseal(raw) {
  if (!sealed.has(raw[0])) return raw;
  const head = raw.subarray(0,9), nonce = raw.subarray(9,21), cipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([Buffer.from([0xa2]), head])); cipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([head, cipher.update(raw.subarray(21,raw.length-16)), cipher.final()]);
}
const protocol = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(fs.readFileSync(path.join(__dirname, '../web/src/proto.ts'), 'utf8'))[1]);
const docPacket = doc => Buffer.concat([Buffer.from([1]), Buffer.from(Y.encodeStateAsUpdate(doc))]);
async function run() {
  const browser = await chromium.launch({ channel: process.env.AJAR_BROWSER_CHANNEL || undefined, headless: true });
  const docs = new Map([['main.ts', new Y.Doc()], ['util.ts', new Y.Doc()]]), opened = [], closed = [], edits = [];
  docs.get('main.ts').getText('content').insert(0, 'const main = 1;\n'); docs.get('util.ts').getText('content').insert(0, 'const util = 2;\n');
  const ids = new Map([['main.ts', 11], ['util.ts', 12]]);
  const subscriptions = new Set(), refused = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let wire, acknowledge = true, hostMissing = false;
    await page.routeWebSocket('**/ws', ws => {
      wire = ws;
      ws.onMessage(data => {
        const raw = unseal(Buffer.from(data)), channel = raw[0], id = raw.readUInt32LE(1);
        if (id) {
          if (channel === 5 && raw[9] === 1) {
            const entry = [...ids].find(([, value]) => value === id);
            if (hostMissing || !entry || !docs.has(entry[0])) return;
            Y.applyUpdate(docs.get(entry[0]), raw.subarray(10)); edits.push(entry[0]);
            if (acknowledge) ws.send(frame(5, raw.subarray(9), id));
          }
          return;
        }
        const msg = JSON.parse(raw.subarray(9));
        if (channel === 1 && msg.t === 'hello') {
          ws.send(frame(1, {t:'welcome', participant_id:2, participants:[], host_protocol:protocol}));
          ws.send(frame(3, {t:'tree', entries:[...docs.keys()].map(path => ({path,kind:'file',size:20}))}));
        }
        if (channel === 5 && msg.t === 'open') {
          opened.push(msg.path);
          if (!docs.has(msg.path)) {
            ws.send(frame(5, {t:'error',path:msg.path,message:'file no longer exists'}));
            return;
          }
          const id = ids.get(msg.path);
          if (!subscriptions.has(id) && subscriptions.size >= 16) {
            refused.push(msg.path);
            ws.send(frame(5, {t:'error',path:msg.path,message:'too many open documents'}));
            return;
          }
          subscriptions.add(id);
          ws.send(frame(5, {t:'opened', doc_id:ids.get(msg.path), path:msg.path}));
          ws.send(frame(5, docPacket(docs.get(msg.path)), ids.get(msg.path)));
        }
        if (channel === 5 && msg.t === 'close') { closed.push(msg.doc_id); subscriptions.delete(msg.doc_id); }
      });
    });
    await page.goto(`http://127.0.0.1:5173/j/editor-documents#k=${key.toString('base64url')}`);
    await page.locator('#name').fill('Editor check'); await page.getByRole('button', {name:'Join',exact:true}).click();
    const open = async file => { await page.locator(`.tree-row[data-path="${file}"]`).click(); await page.waitForFunction(file => document.querySelector('#viewer')?.dataset.editing === file, file); };
    await open('main.ts');
    await page.locator('.editor-group.focused').getByRole('button', {name:/^Split right /}).click();
    await page.waitForFunction(() => document.querySelectorAll('.monaco-editor').length === 2);
    assert.equal(opened.filter(p => p === 'main.ts').length, 1, 'two views open one host subscription');
    const right = page.locator('.editor-group').nth(1), left = page.locator('.editor-group').nth(0);
    await right.locator('.view-lines').click(); await page.keyboard.type('SHARED');
    await page.waitForFunction(() => [...document.querySelectorAll('.view-lines')].every(e => e.textContent.includes('SHARED')));
    assert.equal(docs.get('main.ts').getText('content').toString().split('SHARED').length - 1, 1, 'one shared edit reaches the host');
    await open('util.ts');
    assert.equal(closed.includes(11), false, 'main stays subscribed while visible in the left group');
    const utilBefore = edits.filter(p => p === 'util.ts').length;
    await right.locator('.view-lines').click(); await page.keyboard.type('ONLYUTIL');
    await page.waitForFunction(() => document.querySelector('.editor-group.focused .view-lines').textContent.includes('ONLYUTIL'));
    assert.equal(docs.get('main.ts').getText('content').toString().includes('ONLYUTIL'), false);
    assert(edits.filter(p => p === 'util.ts').length > utilBefore);
    // Narrow screens release clean subscriptions belonging only to hidden groups.
    const closedMain = closed.filter(id => id === 11).length, openedMain = opened.filter(path => path === 'main.ts').length;
    await page.setViewportSize({width:390,height:844});
    for(let i=0;i<100 && closed.filter(id=>id===11).length===closedMain;i++) await page.waitForTimeout(20);
    assert(closed.filter(id=>id===11).length > closedMain, 'hidden phone groups release clean subscriptions');
    await page.setViewportSize({width:1400,height:900});
    for(let i=0;i<100 && opened.filter(path=>path==='main.ts').length===openedMain;i++) await page.waitForTimeout(20);
    assert(opened.filter(path=>path==='main.ts').length > openedMain, 'wider layout restores the visible subscription');
    // A host permission change reaches every file and reopens each visible document.
    wire.send(frame(2, {t:'read_only',read_only:true}));
    await page.waitForFunction(() => document.querySelector('#readonly').hidden === false);
    await page.waitForFunction(() => document.querySelector('#viewer').dataset.editing === 'util.ts');
    const beforeReadonly = edits.length;
    await left.locator('.view-lines').click(); await page.keyboard.type('REFUSED');
    assert.equal(edits.length, beforeReadonly);
    wire.send(frame(2, {t:'read_only',read_only:false}));
    await page.waitForFunction(() => document.querySelector('#readonly').hidden === true);
    await page.waitForFunction(() => document.querySelector('#viewer').dataset.editing === 'main.ts');
    // Keep a closed tab's session until the host confirms its typing.
    await right.getByRole('tab', {name:'util.ts',exact:true}).click();
    acknowledge = false; await right.locator('.view-lines').click(); await page.keyboard.type('PENDING');
    const closes = closed.filter(id => id === 12).length;
    await right.getByRole('button', {name:'Close util.ts',exact:true}).click();
    assert.equal(closed.filter(id => id === 12).length, closes, 'unacknowledged file is retained after close');
    acknowledge = true; wire.send(frame(5, docPacket(docs.get('util.ts')), 12));
    for (let i=0;i<100 && closed.filter(id=>id===12).length===closes;i++) await page.waitForTimeout(20);
    assert(closed.filter(id=>id===12).length > closes, 'confirmed background session is released');
    // Removing the original group must preserve the stable viewer region.
    await left.getByRole('button', {name:'Editor group actions'}).click();
    await page.getByRole('menuitem', {name:'Close group',exact:true}).click();
    assert.equal(await page.locator('#viewer').count(), 1);
    await page.waitForFunction(() => document.querySelector('#viewer').dataset.editing === 'main.ts');
    // A cached LF model can reopen an otherwise valid file converted to CRLF.
    wire.send(frame(5, {t:'closed',doc_id:11,reason:'line endings changed'}));
    await page.waitForFunction(() => document.querySelector('#viewer-title').textContent.includes('line endings changed'));
    const main = docs.get('main.ts').getText('content'); main.delete(0,main.length); main.insert(0,'one\r\ntwo\r\n');
    await open('main.ts');
    await page.locator('.editor-group.focused .view-lines').click(); await page.keyboard.type('CRLF');
    assert(main.toString().includes('CRLF') && main.toString().includes('\r\n'), 'reopening updates the cached model line ending');
    // Historical files must not occupy the host's document slots when a
    // later file is selected during a host outage.
    const history = Array.from({length:18}, (_, i) => `visited-${i}.ts`);
    for (const [i, path] of [...history, 'after-away.ts'].entries()) {
      const doc = new Y.Doc(); doc.getText('content').insert(0, `const visited = ${i};\n`);
      docs.set(path, doc); ids.set(path, 100 + i);
    }
    wire.send(frame(3, {t:'tree',entries:[...docs.keys()].map(path => ({path,kind:'file',size:30}))}));
    for (const path of history) {
      await open(path);
      await page.locator('.editor-group.focused').getByRole('button', {name:`Close ${path}`,exact:true}).click();
    }
    wire.send(frame(1, {t:'host_away',grace_secs:60}));
    await page.locator('#away').waitFor({state:'visible'});
    await page.locator('.tree-row[data-path="after-away.ts"]').click();
    await page.locator('.editor-group.focused').getByRole('tab', {name:'after-away.ts',exact:true}).waitFor();
    const beforeBack = opened.length;
    wire.send(frame(1, {t:'host_back'}));
    await page.waitForFunction(() => document.querySelector('#viewer').dataset.editing === 'after-away.ts');
    assert.deepEqual(opened.slice(beforeBack), ['after-away.ts'], 'host return opens only the newly visible file');
    assert.deepEqual(refused, [], 'closed history never exhausts the 16-document limit');
    // A tab closed with offline edits must become reachable again when the
    // host refuses its deleted file. Exercise both recovery actions.
    for (const [index, action] of ['save', 'discard'].entries()) {
      const path = `recover-${action}.ts`, pending = `PENDING_${action.toUpperCase()}`;
      const doc = new Y.Doc(); doc.getText('content').insert(0, 'const retained = true;\n');
      docs.set(path, doc); ids.set(path, 200 + index);
      wire.send(frame(3, {t:'tree',entries:[...docs.keys()].map(path => ({path,kind:'file',size:30}))}));
      await open(path);
      hostMissing = true;
      wire.send(frame(1, {t:'host_away',grace_secs:60}));
      await page.locator('#away').waitFor({state:'visible'});
      await page.locator('.editor-group.focused .view-lines').click();
      await page.keyboard.type(pending);
      await page.locator('.editor-group.focused').getByRole('button', {name:`Close ${path}`,exact:true}).click();
      assert.equal(await page.getByRole('tab', {name:path,exact:true}).count(), 0, 'the tab closes while its edits are retained');
      doc.destroy(); docs.delete(path);
      wire.send(frame(3, {t:'tree',entries:[...docs.keys()].map(path => ({path,kind:'file',size:30}))}));
      hostMissing = false;
      wire.send(frame(1, {t:'welcome',participant_id:2,participants:[],host_protocol:protocol}));
      const recovery = page.locator('.editor-group.focused');
      await recovery.getByRole('button', {name:'Save local copy',exact:true}).waitFor();
      await recovery.getByRole('button', {name:'Discard local changes',exact:true}).waitFor();
      assert.equal(await recovery.getByRole('tab', {name:path,exact:true}).count(), 1, 'refusal reopens a recovery tab without a tree entry');
      assert.equal(await page.locator(`.tree-row[data-path="${path}"]`).count(), 0);
      assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable:true}))), 'unresolved recovery still warns before leaving');
      if (action === 'save') {
        const downloaded = page.waitForEvent('download');
        await recovery.getByRole('button', {name:'Save local copy',exact:true}).click();
        const download = await downloaded;
        assert.equal(download.suggestedFilename(), path);
        assert(fs.readFileSync(await download.path(), 'utf8').includes(pending), 'download preserves the closed tab\'s unsent text');
      } else {
        page.once('dialog', dialog => dialog.accept());
        await recovery.getByRole('button', {name:'Discard local changes',exact:true}).click();
        assert.equal(await page.getByRole('tab', {name:path,exact:true}).count(), 0, 'discard removes the recovery tab');
      }
      assert(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', {cancelable:true}))), 'resolving recovery clears the leave warning');
    }
    assert.deepEqual(errors, []);
    console.log('Session editor groups: shared subscriptions, permissions, host-return capacity and closed-file recovery.');
  } finally { await browser.close(); for(const doc of docs.values()) doc.destroy(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

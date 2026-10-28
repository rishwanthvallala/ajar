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
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let wire, acknowledge = true;
    await page.routeWebSocket('**/ws', ws => {
      wire = ws;
      ws.onMessage(data => {
        const raw = unseal(Buffer.from(data)), channel = raw[0], id = raw.readUInt32LE(1);
        if (id) {
          if (channel === 5 && raw[9] === 1) {
            const entry = [...ids].find(([, value]) => value === id);
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
          ws.send(frame(5, {t:'opened', doc_id:ids.get(msg.path), path:msg.path}));
          ws.send(frame(5, docPacket(docs.get(msg.path)), ids.get(msg.path)));
        }
        if (channel === 5 && msg.t === 'close') closed.push(msg.doc_id);
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
    assert.deepEqual(errors, []);
    console.log('Session editor groups: shared subscription, independent files, permissions and pending-edit retention.');
  } finally { await browser.close(); for(const doc of docs.values()) doc.destroy(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

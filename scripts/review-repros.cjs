// Focused review reproductions. Executes the actual TypeScript classes with
// in-memory UI/HTTP/runtime doubles; this is not a browser or WASIX E2E suite.
// Run: node scripts/review-repros.cjs
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
globalThis.crypto ??= require('node:crypto').webcrypto;
const root = path.resolve(__dirname, '..');
const padRequire = createRequire(path.join(root, 'pad/package.json'));
const ts = padRequire('typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const local = createRequire(file);
  const customRequire = (name) => {
    if (name.endsWith('?raw')) return fs.readFileSync(path.resolve(path.dirname(file), name.slice(0, -4)), 'utf8');
    if (name.startsWith('.')) {
      const candidate = path.resolve(path.dirname(file), name + '.ts');
      if (fs.existsSync(candidate)) return load(candidate);
    }
    return local(name);
  };
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(customRequire, mod, mod.exports);
  return mod.exports;
}
const { App } = load('pad/src/app.ts');
const { Console } = load('pad/src/console.ts');
const { FileTree } = load('pad/src/files.ts');
const { DocSession } = load('pad/src/editing.ts');
const { streamFor, DOC_UPDATE } = load('pad/src/peers.ts');
const { Sealer, SealDirection } = load('web/src/sealed.ts');
const Y = padRequire('yjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(files) {
  return {
    files: new Map(Object.entries(files)),
    async write(p, c) { this.files.set(p, c); },
    async remove(p) { this.files.delete(p); },
    async read(p) { return this.files.get(p); },
    async list() { return [...this.files.keys()].map(path => ({ path, size: 1 })); },
  };
}
function app(store, rt) {
  const el = { status: { dataset: {} }, run: { disabled: false } };
  const a = new App('review-fixture', store, el);
  a.renderFiles = () => {};
  a.warm = () => {};
  a.runtime = Promise.resolve(rt);
  a.models = new Map();
  a.setFile = (p, text) => a.models.set(p, { getValue: () => text, dispose() {} });
  return a;
}
const results = [];
async function regression(name, fn) {
  await fn();
  results.push(name);
  console.log('FIXED: ' + name);
}
(async () => {
  await regression('Host PTY ciphertext is bound to its direction', async () => {
    const sealer = await Sealer.fromHash('#k=' + Buffer.alloc(32, 7).toString('base64url'));
    const output = { channel: 2, streamId: 1, target: 2, payload: new TextEncoder().encode('command-looking terminal output\r') };
    const sealed = await sealer.seal(output, SealDirection.HostToGuest);
    const reflected = await sealer.open(sealed, SealDirection.GuestToHost);
    assert.equal(reflected, null);
  });
  await regression('Arrow-left moves the console cursor without inserting bytes', async () => {
    const c = new Console({ write() {} }, async () => null, () => {});
    c.handle('abc');
    c.handle('\x1b[D');
    c.handle('X');
    assert.equal(c.line, 'abXc');
  });
  await regression('A Run-button command owns console input and Ctrl-C', async () => {
    let closed = 0;
    const shell = { alive: true, close: async () => { closed++; } };
    const c = new Console({ write() {} }, async () => shell, () => {});
    c.attach(shell);
    c.announce('python main.py');
    c.handle('\x03');
    await tick();
    assert.equal(c.busy, true);
    assert.equal(closed, 1);
  });
  await regression('A remotely deleted file is removed from the runtime', async () => {
    const writes = [];
    const rt = runtime({ 'deleted.txt': 'old' });
    const a = app({ read: async () => ({ files: {}, seq: 2 }), write: async (_, c) => { writes.push(c); return 3; } }, rt);
    a.known.set('deleted.txt', 'old');
    a.setFile('deleted.txt', 'old');
    await a.refresh();
    assert.equal(a.models.has('deleted.txt'), false);
    assert.equal(rt.files.has('deleted.txt'), false);
    await a.publish(rt);
    assert.equal(writes.length, 0);
  });
  await regression('Remote CRDT edits update the execution runtime before publication', async () => {
    const writes = [];
    const rt = runtime({ 'note.txt': 'old' });
    const a = app({ read: async () => ({ files: { 'note.txt': { content: 'new', encoding: 'utf8', seq: 2 } }, seq: 2 }), write: async (_, c) => { writes.push(c); return 3; } }, rt);
    a.known.set('note.txt', 'old');
    const doc = new DocSession(streamFor('note.txt'), 'note.txt', { id: 1, name: 'test' }, () => {});
    const peer = new Y.Doc();
    doc.seed('old');
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc));
    peer.getText('content').delete(0, 3);
    peer.getText('content').insert(0, 'new');
    a.docs.set('note.txt', doc);
    a.byStream.set(streamFor('note.txt'), 'note.txt');
    a.onDoc(streamFor('note.txt'), DOC_UPDATE, Y.encodeStateAsUpdate(peer));
    await tick();
    assert.equal(doc.contents(), 'new');
    await a.refresh();
    assert.equal(rt.files.get('note.txt'), 'new');
    await a.publish(rt);
    assert.equal(writes.length, 0);
    doc.destroy();
    peer.destroy();
  });
  await regression('Autosaves are serialized in edit order', async () => {
    const queued = [];
    let durable = '';
    const rt = runtime({ 'a.txt': 'zero' });
    const a = app({ write: (_, changes) => new Promise(resolve => queued.push(() => { durable = changes[0].content; resolve(queued.length); })) }, rt);
    a.known.set('a.txt', 'zero');
    a.setFile('a.txt', 'first');
    a.dirty.add('a.txt');
    const first = a.saveEdits();
    a.setFile('a.txt', 'second');
    a.dirty.add('a.txt');
    const second = a.saveEdits();
    await tick();
    assert.equal(queued.length, 1);
    queued[0](); await first;
    await tick();
    assert.equal(queued.length, 2);
    queued[1](); await second;
    assert.equal(durable, 'second');
    assert.equal(a.models.get('a.txt').getValue(), 'second');
    assert.equal(a.dirty.size, 0);
  });
  await regression('A valid empty CRDT response is not reseeded from stored text', async () => {
    const source = new DocSession(1, 'a.txt', { id: 1, name: 'one' }, () => {});
    source.seed('old');
    source.ytext.delete(0, 3);
    const a = app({}, runtime({ 'a.txt': 'old' }));
    a.known.set('a.txt', 'old');
    a.peers = {
      ready: Promise.resolve(),
      alone: false,
      doc(stream, kind) {
        if (kind === 3) setImmediate(() => a.onDoc(stream, DOC_UPDATE, Y.encodeStateAsUpdate(source.ydoc)));
      },
    };
    const newcomer = await a.readyDoc('a.txt');
    assert.equal(newcomer.contents(), '');
    source.destroy(); newcomer.destroy();
  });
  await regression('Legacy file/directory conflicts render defensively', async () => {
    const element = () => ({ className: '', style: {}, dataset: {}, append() {}, setAttribute() {}, replaceChildren() {} });
    globalThis.document = { createElement: element };
    const tree = new FileTree(element(), { onOpen() {}, onNewFile() {}, onNewFolder() {} });
    assert.doesNotThrow(() => tree.render(['a', 'a/b'], ''));
  });
  console.log('\n' + results.length + ' focused regressions pass in actual application classes.');
})().catch(e => { console.error(e); process.exitCode = 1; });

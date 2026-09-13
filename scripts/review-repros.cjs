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
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
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
const { Sealer } = load('web/src/sealed.ts');
const Y = padRequire('yjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(files) {
  return {
    files: new Map(Object.entries(files)),
    async write(p, c) { this.files.set(p, c); },
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
async function repro(name, fn) {
  await fn();
  results.push(name);
  console.log('REPRODUCED: ' + name);
}
(async () => {
  await repro('A targeted host PTY ciphertext also authenticates as guest-to-host input', async () => {
    const sealer = await Sealer.fromHash('#k=' + Buffer.alloc(32, 7).toString('base64url'));
    const output = { channel: 2, streamId: 1, target: 2, payload: new TextEncoder().encode('command-looking terminal output\r') };
    const sealed = await sealer.seal(output);
    // Host->guest target=2 and guest(2)->host sender=2 have identical AAD.
    // Reflection uses unchanged ciphertext and no secret-key knowledge.
    const reflected = await sealer.open(sealed);
    assert.deepEqual(reflected.payload, output.payload);
  });
  await repro('Arrow-left inserts [D instead of moving the console cursor', async () => {
    const c = new Console({ write() {} }, async () => null, () => {});
    c.handle('abc');
    c.handle('\x1b[D');
    c.handle('X');
    assert.equal(c.line, 'abc[DX');
  });
  await repro('A Run-button command does not put Console into running mode; Ctrl-C never closes the shell', async () => {
    let closed = 0;
    const shell = { alive: true, close: async () => { closed++; } };
    const c = new Console({ write() {} }, async () => shell, () => {});
    c.attach(shell);
    c.announce('python main.py');
    c.handle('\x03');
    await tick();
    assert.equal(c.busy, false);
    assert.equal(closed, 0);
  });
  await repro('A remotely deleted file survives in the runtime and is recreated by the next publish', async () => {
    const writes = [];
    const rt = runtime({ 'deleted.txt': 'old' });
    const a = app({ read: async () => ({ files: {}, seq: 2 }), write: async (_, c) => { writes.push(c); return 3; } }, rt);
    a.known.set('deleted.txt', 'old');
    a.setFile('deleted.txt', 'old');
    await a.refresh();
    assert.equal(a.models.has('deleted.txt'), false);
    assert.equal(rt.files.has('deleted.txt'), true);
    await a.publish(rt);
    assert.deepEqual(writes[0], [{ path: 'deleted.txt', content: 'old' }]);
  });
  await repro('Remote CRDT edits update the document but leave runtime stale; publish overwrites durable text', async () => {
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
    assert.equal(doc.contents(), 'new');
    await a.refresh();
    assert.equal(rt.files.get('note.txt'), 'old');
    await a.publish(rt);
    assert.deepEqual(writes[0], [{ path: 'note.txt', content: 'old' }]);
    doc.destroy();
    peer.destroy();
  });
  await repro('Overlapping autosaves allow an older request to overwrite newer text', async () => {
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
    assert.equal(queued.length, 2);
    queued[1](); await second;
    queued[0](); await first;
    assert.equal(durable, 'first');
    assert.equal(a.models.get('a.txt').getValue(), 'second');
    assert.equal(a.dirty.size, 0);
  });
  await repro('An empty state response after a complete CRDT deletion reseeds old stored text', async () => {
    const source = new DocSession(1, 'a.txt', { id: 1, name: 'one' }, () => {});
    const newcomer = new DocSession(1, 'a.txt', { id: 2, name: 'two' }, () => {});
    source.seed('old');
    source.ytext.delete(0, 3);
    newcomer.applyUpdate(Y.encodeStateAsUpdate(source.ydoc));
    assert.equal(newcomer.length, 0);
    newcomer.seed('old'); // readyDoc uses length===0 even after a valid reply.
    assert.equal(newcomer.contents(), 'old');
    source.destroy(); newcomer.destroy();
  });
  await repro('Accepted file paths a and a/b crash the pad tree renderer', async () => {
    const tree = new FileTree({}, {});
    assert.throws(() => tree.render(['a', 'a/b'], ''), /Cannot read properties of null/);
  });
  console.log('\n' + results.length + ' defects reproduced in actual application classes.');
})().catch(e => { console.error(e); process.exitCode = 1; });

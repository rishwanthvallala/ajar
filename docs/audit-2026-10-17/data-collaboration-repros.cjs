// Audit-only deterministic reproductions. Uses actual TS classes with in-memory
// doubles; deliberately does not contact production or alter application code.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'pad/package.json'));
const ts = req('typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const local = createRequire(file);
  const custom = name => {
    if (name.startsWith('@ajar/workspace-ui')) return load('packages/workspace-ui/src/' + (name.split('/')[2] || 'index') + '.ts');
    if (name.endsWith('?raw')) return fs.readFileSync(path.resolve(path.dirname(file), name.slice(0, -4)), 'utf8');
    if (name.startsWith('.')) {
      const p = path.resolve(path.dirname(file), name + '.ts');
      if (fs.existsSync(p)) return load(p);
    }
    return local(name);
  };
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})').replaceAll('import.meta.url', JSON.stringify('file://' + file.replaceAll('\\', '/')));
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(custom, mod, mod.exports);
  return mod.exports;
}
const results = [];
function record(test, observed) { results.push({ test, observed }); console.log(JSON.stringify(results.at(-1))); }
function app(store) {
  const { App } = load('pad/src/app.ts');
  const a = new App('audit-only', store, { markdownPane: { hidden: true } });
  a.say = (kind, text) => { a.status = { kind, text }; };
  a.renderFiles = () => {};
  a.setFile = (p, text) => a.models.set(p, { getValue: () => text, getValueLength: () => text.length, dispose() {} });
  return a;
}
(async () => {
  const { Store, StoreError } = load('pad/src/store.ts');
  const { streamFor, DOC_UPDATE } = load('pad/src/peers.ts');
  const { DocSession, seedId } = load('pad/src/editing.ts');
  const { applied, carryOver } = load('pad/src/carry.ts');
  const Y = req('yjs');
  const a = app({ write: async () => { throw new StoreError(507, 'storage full'); } });
  a.known.set('work.txt', 'old'); a.setFile('work.txt', 'unsaved work'); a.dirty.add('work.txt');
  await a.saveEdits();
  assert.equal(a.dirty.size, 0); assert.equal(a.known.get('work.txt'), 'old'); assert.equal(a.saveTimer, null);
  record('quota rejection forgets unsaved state', { dirty: a.dirty.size, retry: a.saveTimer, model: a.current('work.txt'), durable: a.known.get('work.txt'), status: a.status });

  const storedBase = '0'.repeat(17000); let durable = storedBase + 'THEIRS'; const attempts = [];
  const stale = app({ editsWork: true, write: async (_name, writes) => { attempts.push(writes); if (writes[0].edits) throw new StoreError(409, 'stale'); durable = writes[0].content; return 2; } });
  stale.known.set('long.txt', storedBase); stale.setFile('long.txt', 'MINE' + storedBase); stale.dirty.add('long.txt');
  await stale.saveEdits();
  assert.equal(durable, 'MINE' + storedBase); assert.equal(attempts.length, 2);
  record('stale-write fallback overwrites a concurrent stored edit', { firstAttempt: 'hash-conditional edit rejected with 409', secondAttempt: 'unconditional complete replacement', keptMine: durable.startsWith('MINE'), keptTheirs: durable.endsWith('THEIRS'), status: stale.status });

  const movingFiles = new Map([['a/a/x.txt', 'first'], ['a/a/a/x.txt', 'second']]);
  const moved = app({ write: async (_name, writes) => { for (const w of writes) { if (w.content === null) movingFiles.delete(w.path); else movingFiles.set(w.path, w.content); } return 1; } });
  for (const [p, text] of movingFiles) { moved.known.set(p, text); moved.setFile(p, text); }
  await moved.move('a/a', true, 'a');
  assert.equal(movingFiles.get('a/x.txt'), 'first'); assert.equal(movingFiles.has('a/a/x.txt'), false);
  record('drag nested same-name folder to ancestor deletes moved descendant', { move: 'a/a -> a', expected: { 'a/x.txt': 'first', 'a/a/x.txt': 'second' }, stored: Object.fromEntries(movingFiles), modelPaths: [...moved.models.keys()], status: moved.status });

  const base = 'A\nB\nC\n', mine = 'a\nB\nc\n', theirs = 'A\nB!\nC\n';
  const merged = applied(theirs, carryOver(base, mine, theirs));
  assert.notEqual(merged, 'a\nB!\nc\n');
  record('disjoint command edits conflict with intervening typing', { base, mine, theirs, merged, expected: 'a\nB!\nc\n' });

  let pair; const hashes = new Map(); let rng = 123456789;
  for (let i = 0; i < 300000; i++) {
    rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
    const p = 'file-' + (rng >>> 0).toString(36) + '.txt'; const h = streamFor(p);
    if (hashes.has(h)) { pair = [hashes.get(h), p, h]; break; } hashes.set(h, p);
  }
  assert.ok(pair, 'collision search');
  const b = app({}); b.known.set(pair[0], 'same'); b.known.set(pair[1], 'same');
  const first = await b.readyDoc(pair[0]), second = await b.readyDoc(pair[1]);
  const remote = new Y.Doc(); Y.applyUpdate(remote, Y.encodeStateAsUpdate(first.ydoc));
  remote.getText('content').insert(4, ' WRONG-FILE');
  b.onDoc(pair[2], DOC_UPDATE, Y.encodeStateAsUpdate(remote), 2);
  assert.equal(first.contents(), 'same'); assert.equal(second.contents(), 'same WRONG-FILE');
  record('32-bit path collision routes edits to another file', { paths: pair.slice(0, 2), stream: pair[2], first: first.contents(), second: second.contents() });
  b.closeDoc(pair[0]); b.closeDoc(pair[1]); remote.destroy();

  const left = new DocSession(1, 'x', { id: 1, name: 'a' }, () => {});
  const right = new DocSession(1, 'x', { id: 2, name: 'b' }, () => {});
  left.seed(pair[0]); right.seed(pair[1]);
  assert.equal(seedId(pair[0]), seedId(pair[1]));
  left.applyUpdate(Y.encodeStateAsUpdate(right.ydoc)); right.applyUpdate(Y.encodeStateAsUpdate(left.ydoc));
  assert.notEqual(left.contents(), right.contents());
  record('32-bit seed collision leaves divergent documents', { seed: seedId(pair[0]), left: left.contents(), right: right.contents(), foreignRootDetected: left.foreignRoot(Y.encodeStateAsUpdate(right.ydoc)) });
  left.destroy(); right.destroy();

  const originalFetch = global.fetch; let controller; let requestSignal;
  global.fetch = async (_url, init) => { requestSignal = init.signal; return new Response(new ReadableStream({ start(c) { controller = c; } }), { status: 200 }); };
  const start = Date.now(); let state = 'pending';
  const pending = new Store('', () => null, 20).write('audit-only', [{ path: 'x', content: 'y' }]).then(() => state = 'resolved', () => state = 'rejected');
  await new Promise(r => setTimeout(r, 160));
  assert.equal(state, 'pending'); assert.equal(requestSignal.aborted, false);
  record('headers end the timeout while response body can stall forever', { configuredDeadlineMs: 20, elapsedMs: Date.now() - start, state, aborted: requestSignal.aborted });
  controller.enqueue(new TextEncoder().encode('{"seq":1,"hashes":{}}')); controller.close(); await pending;
  global.fetch = originalFetch;

  const { readZip } = load('pad/src/zip.ts');
  const data = Buffer.alloc(16 * 1024 * 1024, 65), packed = deflateRawSync(data), name = Buffer.from('bomb.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(1, 24); cd.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  const zip = new Blob([local, name, packed, cd, name, end]);
  let inflated = 0; const realArrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function () { const value = await realArrayBuffer.call(this); inflated = Math.max(inflated, value.byteLength); return value; };
  try { await assert.rejects(readZip(zip, { maxFiles: 1, maxBytes: 1024 }), /sizes do not add up/); }
  finally { Response.prototype.arrayBuffer = realArrayBuffer; }
  assert.equal(inflated, data.length);
  record('ZIP limit is checked only after full inflation', { zipBytes: zip.size, declaredBytes: 1, configuredLimitBytes: 1024, fullyInflatedBytesBeforeRejection: inflated });
  fs.writeFileSync(path.join(__dirname, 'data-collaboration-repros.json'), JSON.stringify(results, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });

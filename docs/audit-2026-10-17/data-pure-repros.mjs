// Dependency-free audit probes of actual TypeScript modules (Node 24).
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
process.on('uncaughtException', e => { console.error(e.name + ': ' + e.message.slice(0, 400)); process.exitCode = 1; });
const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const urls = new Map();
function moduleUrl(file) {
  if (urls.has(file)) return urls.get(file);
  let js = stripTypeScriptTypes(source(file), { mode: 'transform' });
  if (file.endsWith('zip.ts')) js = js.replace('"./sync"', JSON.stringify(moduleUrl('pad/src/sync.ts')));
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64'); urls.set(file, url); return url;
}
const { Store } = await import(moduleUrl('pad/src/store.ts'));
const { streamFor } = await import(moduleUrl('pad/src/peers.ts'));
const { applied, carryOver } = await import(moduleUrl('pad/src/carry.ts'));
const { readZip } = await import(moduleUrl('pad/src/zip.ts'));
const results = [];
function record(test, observed) { results.push({ test, observed }); console.log(JSON.stringify(results.at(-1))); }
let pair; const hashes = new Map(); let rng = 123456789;
for (let i = 0; i < 300000; i++) {
  rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
  const p = 'file-' + (rng >>> 0).toString(36) + '.txt'; const h = streamFor(p);
  if (hashes.has(h)) { pair = [hashes.get(h), p, h]; break; } hashes.set(h, p);
}
assert.ok(pair);
record('distinct valid file paths share the same document stream', { paths: pair.slice(0, 2), stream: pair[2] });
const base = 'A\nB\nC\n', mine = 'a\nB\nc\n', theirs = 'A\nB!\nC\n';
record('coarse merge duplicates originals', { base, mine, theirs, merged: applied(theirs, carryOver(base, mine, theirs)), expected: 'a\nB!\nc\n' });
const originalFetch = globalThis.fetch; let controller; let requestSignal;
globalThis.fetch = async (_url, init) => { requestSignal = init.signal; return new Response(new ReadableStream({ start(c) { controller = c; } }), { status: 200 }); };
const start = Date.now(); let state = 'pending';
const pending = new Store('', () => null, 20).write('audit-only', [{ path: 'x', content: 'y' }]).then(() => state = 'resolved', () => state = 'rejected');
await new Promise(r => setTimeout(r, 160));
assert.equal(state, 'pending'); assert.equal(requestSignal.aborted, false);
record('headers end timeout before stalled body completes', { configuredDeadlineMs: 20, elapsedMs: Date.now() - start, state, aborted: requestSignal.aborted });
controller.enqueue(new TextEncoder().encode('{"seq":1,"hashes":{}}')); controller.close(); await pending; globalThis.fetch = originalFetch;
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
record('ZIP inflated beyond limit before rejection', { zipBytes: zip.size, declaredBytes: 1, configuredLimitBytes: 1024, fullyInflatedBytesBeforeRejection: inflated });
// The App module is evaluated with only the dependencies used by these paths.
// UI/runtime are doubles, and unrelated import bindings are intentionally absent.
let appJS = stripTypeScriptTypes(source('pad/src/app.ts').replaceAll('import.meta.env', '({})'), { mode: 'transform' });
appJS = appJS.replace(/^import\s+(?:\{[\s\S]*?\}|\*\s+as\s+\w+|\w+)\s+from\s+["'][^"']+["'];\s*/gm, '');
appJS = appJS.replace(/^import\s+["'][^"']+["'];\s*/gm, '');
appJS = `import { StoreError, storedHash } from ${JSON.stringify(moduleUrl('pad/src/store.ts'))};\nimport { carryOver } from ${JSON.stringify(moduleUrl('pad/src/carry.ts'))};\nimport { isMarker, knownFrom, binariesFrom, fromBase64 } from ${JSON.stringify(moduleUrl('pad/src/sync.ts'))};\nimport { readZip, prepareImport, ZipError, PAD_LIMITS, leftOut } from ${JSON.stringify(moduleUrl('pad/src/zip.ts'))};\nconst OPEN={role:'editor',account:false};\nconst confirmDialog=async()=>true;\nclass FetchBridge {}\nclass JavacBridge {}\n` + appJS;
const { App } = await import('data:text/javascript;base64,' + Buffer.from(appJS).toString('base64'));
const { StoreError } = await import(moduleUrl('pad/src/store.ts'));
function app(store) {
  const a = new App('audit-only', store, { markdownPane: { hidden: true } });
  a.say = (kind, text) => { a.status = { kind, text }; };
  a.renderFiles = () => {};
  a.setFile = (p, text) => a.models.set(p, { getValue: () => text, getValueLength: () => text.length, dispose() {} });
  return a;
}
const rejected = app({ write: async () => { throw new StoreError(507, 'storage full'); } });
rejected.known.set('work.txt', 'old'); rejected.setFile('work.txt', 'unsaved work'); rejected.dirty.add('work.txt');
await rejected.saveEdits();
assert.equal(rejected.dirty.size, 0); assert.equal(rejected.known.get('work.txt'), 'old'); assert.equal(rejected.saveTimer, null);
record('quota rejection forgets unsaved state', { dirty: rejected.dirty.size, retry: rejected.saveTimer, model: rejected.current('work.txt'), durable: rejected.known.get('work.txt'), status: rejected.status });
const storedBase = '0'.repeat(17000); let durable = storedBase + 'THEIRS'; const attempts = [];
const stale = app({ editsWork: true, write: async (_name, writes) => { attempts.push(writes); if (writes[0].edits) throw new StoreError(409, 'stale'); durable = writes[0].content; return 2; } });
stale.known.set('long.txt', storedBase); stale.setFile('long.txt', 'MINE' + storedBase); stale.dirty.add('long.txt');
await stale.saveEdits();
assert.equal(durable, 'MINE' + storedBase); assert.equal(attempts.length, 2);
record('stale-write fallback overwrites concurrent stored edit', { firstAttempt: 'hash-conditional edit rejected 409', secondAttempt: 'unconditional complete replacement', keptMine: durable.startsWith('MINE'), keptTheirs: durable.endsWith('THEIRS'), status: stale.status });
const movingFiles = new Map([['a/a/x.txt', 'first'], ['a/a/a/x.txt', 'second']]);
const moved = app({ write: async (_name, writes) => { for (const w of writes) { if (w.content === null) movingFiles.delete(w.path); else movingFiles.set(w.path, w.content); } return 1; } });
for (const [p, text] of movingFiles) { moved.known.set(p, text); moved.setFile(p, text); }
await moved.move('a/a', true, 'a');
assert.equal(movingFiles.get('a/x.txt'), 'first'); assert.equal(movingFiles.has('a/a/x.txt'), false);
record('move folder to ancestor deletes moved descendant', { move: 'a/a -> a', expected: { 'a/x.txt': 'first', 'a/a/x.txt': 'second' }, stored: Object.fromEntries(movingFiles), modelPaths: [...moved.models.keys()], status: moved.status });
const shared = new Map([['main.py', '# open elsewhere'], ['target.txt', 'old']]); let seq = 1;
const store = {
  async write(_name, writes) { for (const w of writes) shared.set(w.path, w.content); return ++seq; },
  async read() { return { seq, files: Object.fromEntries([...shared].map(([p, content]) => [p, { content, encoding: 'utf8', seq }])) }; },
};
const importing = app(store), peer = app(store);
for (const a of [importing, peer]) { for (const [p, text] of shared) { a.known.set(p, text); a.setFile(p, text); } a.active = 'main.py'; a.adopt = () => {}; }
let live = 'old'; peer.docs.set('target.txt', { ready: true, hasState: true, contents: () => live });
const { makeZip } = await import(moduleUrl('pad/src/zip.ts'));
const archive = await makeZip([{ path: 'target.txt', data: new TextEncoder().encode('IMPORTED') }]);
await importing.importZip(new File([archive], 'audit.zip'));
assert.equal(shared.get('target.txt'), 'IMPORTED');
await peer.refresh();
assert.equal(peer.current('target.txt'), 'old');
const afterImport = { stored: shared.get('target.txt'), peerText: peer.current('target.txt'), importerStatus: importing.status };
live = 'old plus next edit'; peer.dirty.add('target.txt'); await peer.saveEdits();
assert.equal(shared.get('target.txt'), 'old plus next edit');
record('ZIP replacing a file open only on a peer is undone by next peer edit', { afterImport, afterPeerEdit: shared.get('target.txt'), importedContentLost: !shared.get('target.txt').includes('IMPORTED') });
const { diff } = await import(moduleUrl('pad/src/sync.ts'));
const unreadable = await diff({ async list() { return [{ path: 'existing.txt' }]; }, async readBytes() { throw Error('temporary read failure'); } }, new Map([['existing.txt', 'important data']]));
assert.deepEqual(unreadable.changes, [{ path: 'existing.txt', content: null }]);
record('runtime read failure produces deletion of still-existing file', { listed: ['existing.txt'], read: 'throws temporary read failure', outgoingChanges: unreadable.changes });
writeFileSync(new URL('./data-pure-repros.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');

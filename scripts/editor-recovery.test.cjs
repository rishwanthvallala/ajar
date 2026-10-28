// Exercise App's recovery paths with the real diff and CRDT binding, using
// small runtime/Monaco doubles so these regressions need no browser or WASM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const padRequire = createRequire(path.join(root, 'pad/package.json'));
const ts = padRequire('typescript');
const Y = padRequire('yjs');
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const dependencies = name => {
    if (name === '@ajar/workspace-ui/eol') return load('packages/workspace-ui/src/eol.ts');
    if (name === 'yjs' || name === 'y-protocols/awareness') return padRequire(name);
    if (['./carry', './sync', './texts', './editing', './images'].includes(name)) return load(`pad/src/${name.slice(2)}.ts`);
    if (name === './editor-layout') return load('packages/workspace-ui/src/editor-layout.ts');
    // Other UI/services aren't used by the methods under test.
    if (name === './peers') return { streamFor: () => 1 };
    return {};
  };
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(dependencies, mod, mod.exports);
  return mod.exports;
}
const { App } = load('pad/src/app.ts');
const { Texts } = load('pad/src/texts.ts');
const { DocSession } = load('pad/src/editing.ts');
const { EditorLayoutModel } = load('packages/workspace-ui/src/editor-layout.ts');
const { EditorGroups } = load('packages/workspace-ui/src/editor-groups.ts');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
  static fromPositions(a, b) { return new Range(a.lineNumber, a.column, b.lineNumber, b.column); }
}
function model(text) {
  const listeners = new Set();
  return {
    getValue: () => text,
    getValueLength: () => text.length,
    getEOL: () => '\n',
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
    isDisposed: () => false,
    onDidChangeContent(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    applyEdits(edits) {
      const changes = edits.map(e => ({ rangeOffset: e.range.startColumn - 1, rangeLength: e.range.endColumn - e.range.startColumn, text: e.text }));
      for (const c of changes) text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
      for (const fn of listeners) fn({ changes });
    },
    pushEditOperations(_, edits) { this.applyEdits(edits); },
    dispose() {},
  };
}
function view(m) {
  return {
    attached: null, detach: null,
    editor: {
      getModel: () => m,
      updateOptions() {},
      saveViewState: () => null,
      onDidChangeCursorSelection: () => ({ dispose() {} }),
      createDecorationsCollection: () => ({ set() {}, clear() {} }),
    },
  };
}
function runtime(files) {
  return {
    files: new Map(Object.entries(files)),
    async list() { return [...this.files.keys()].map(path => ({ path })); },
    async readBytes(path) {
      const value = this.files.get(path);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
    async write(path, text) { this.files.set(path, text); },
    async settled() {}, takeVersions: () => new Map(), saw() {},
  };
}
function fixture(store = {}) {
  // Skip booting unrelated browser services; all recovery methods are App's.
  const a = Object.assign(Object.create(App.prototype), {
    name: 'recovery', store, access: { role: 'editor' }, active: 'util.py',
    monaco: { Range }, texts: new Texts((_, text) => model(text)),
    known: new Map(), binaries: new Map(), local: new Set(), dirty: new Set(),
    orphaned: new Set(), pendingImages: new Set(), editorViews: new Map(), docs: new Map(), docReady: new Map(),
    defaultFormatted: new Set(), markdownModes: new Map(), viewStates: new Map(),
    shownUnbound: new Map(), seeds: new Map(), byStream: new Map(),
    awaiting: new Map(), unanswered: new Map(), stuck: new Map(), atDrop: new Map(),
    sessions: [], storeSeq: 1, writeChain: Promise.resolve(),
    el: { status: {}, markdownPane: { hidden: true } },
    renderFiles() {}, adopt() {}, journal() {}, paintOrphan() {},
  });
  a.texts.put('util.py', 'utility');
  return a;
}

test('command publication excludes retained deleted files from writes and baselines', async () => {
  const writes = [];
  const a = fixture({
    read: async () => ({ seq: 2, files: {} }),
    write: async (_, changes) => { writes.push(...changes); return 3; },
  });
  const rt = runtime({ 'main.py': 'base with local edits' });
  a.runtime = Promise.resolve(rt); a.runtimeReady = true;
  a.known.set('main.py', 'base');
  a.texts.put('main.py', 'base with local edits');
  const m = a.texts.model('main.py');
  a.editorViews.set('background', view(m));
  await a.refresh();
  assert(a.orphaned.has('main.py'));
  assert.equal(rt.files.get('main.py'), 'base with local edits');
  for (let i = 0; i < 2; i++) {
    await a.publish(rt);
    assert.deepEqual(writes, [], 'an unchanged runtime never recreates the deleted file');
    assert(!a.known.has('main.py'));
    assert(!a.binaries.has('main.py'));
  }
  // Even a command changing its encoding must leave the recovery copy local,
  // while publishing other files from the same command normally.
  rt.files.set('main.py', new Uint8Array([0, 1, 2]));
  rt.files.set('new.txt', 'command output');
  await a.publish(rt);
  assert.deepEqual(writes, [{ path: 'new.txt', content: 'command output' }]);
  assert(!a.known.has('main.py'));
  assert(!a.binaries.has('main.py'));
  assert.equal(a.known.get('new.txt'), 'command output');
  assert.equal(m.getValue(), 'base with local edits');
});

function groupsFor(a, layout) {
  const groups = Object.assign(Object.create(EditorGroups.prototype), {
    model: layout, views: new Map(), render() { a.renderFiles(); },
  });
  // Retain the real prune path, including synchronous render callbacks.
  delete a.renderFiles;
  a.tree = { render() {} };
  a.ui = { groups, setFileCount() {} };
  return groups;
}

test('a remote folder move renames tabs in all groups before render callbacks prune', async () => {
  const a = fixture({ read: async () => ({ seq: 2, files: {
    'new/a.py': { content: 'first', encoding: 'utf8' },
    'new/b.py': { content: 'second', encoding: 'utf8' },
  } }) });
  a.active = 'old/a.py';
  a.show = path => { a.active = path; a.renderFiles(); };
  for (const [path, text] of [['old/a.py', 'first'], ['old/b.py', 'second']]) {
    a.known.set(path, text); a.texts.put(path, text);
  }
  const layout = new EditorLayoutModel();
  layout.open('old/a.py'); const left = layout.current.id;
  layout.split('right'); layout.open('old/b.py'); const right = layout.current.id;
  a.editorViews.set(left, { ...view(a.texts.model('old/a.py')), states: new Map([['old/a.py', { cursor: 12 }]]) });
  a.editorViews.set(right, { ...view(a.texts.model('old/b.py')), states: new Map([['old/b.py', { cursor: 34 }]]) });
  const groups = groupsFor(a, layout);
  await a.refresh();
  assert.equal(groups.model.groups.length, 2);
  assert.deepEqual(groups.model.group(left).tabs, ['new/a.py']);
  assert.deepEqual(groups.model.group(right).tabs, ['new/a.py', 'new/b.py']);
  assert.equal(groups.model.group(right).active, 'new/b.py');
  assert.deepEqual(a.editorViews.get(right).states.get('new/b.py'), { cursor: 34 });
  assert.equal(a.active, 'new/a.py');
});

test('a plot announced before publication renders from runtime and refreshes when regenerated', async () => {
  const previousDocument = globalThis.document;
  const element = () => ({ dataset: {}, hidden: false, children: [], replaceChildren(...children) { this.children = children; } });
  globalThis.document = { createElement: element };
  try {
    const a = fixture({ write: async () => 2 });
    const layout = new EditorLayoutModel(); layout.open('util.py');
    const groups = groupsFor(a, layout);
    const selected = { id: layout.current.id, element: { focus() {} } };
    groups.views.set(selected.id, selected);
    const hosts = { editor: element(), imagePane: element(), markdownPane: element() };
    hosts.editor.dataset.active = 'util.py'; hosts.imagePane.hidden = true;
    const held = { ...view(a.texts.model('util.py')), states: new Map() };
    a.editorViews.set(selected.id, held);
    a.editor = held.editor; a.groupId = selected.id;
    Object.assign(a.el, hosts);
    Object.assign(a.ui, {
      useGroup: () => hosts, groupHosts: () => hosts, setActiveFile() {}, setImage() {}, fileSelected: () => true,
    });
    a.paintRun = a.paintTools = a.paintStarter = a.paintBanner = () => {};
    // Mirror EditorGroups' selection cache: repeated opens of an active tab
    // don't call selectGroup again.
    let previous = 'util.py';
    groups.render = () => {
      const path = groups.current.active;
      if (path !== previous) { previous = path; a.selectGroup(selected, path); }
    };
    const rt = runtime({ 'plot.png': new Uint8Array([0, 1, 2, 3]) });
    a.runtimeReady = true; a.runtime = Promise.resolve(rt);
    await a.showImage('plot.png');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hosts.imagePane.children[0]?.src, 'data:image/png;base64,AAECAw==');
    assert.equal(hosts.imagePane.hidden, false);
    assert.equal(a.binaries.has('plot.png'), false, 'the store has not published this plot yet');
    assert.equal(groups.current.active, 'plot.png', 'renderFiles retains the unpublished image tab');
    await a.publish(rt);
    assert.equal(groups.current.active, 'plot.png', 'publishing the first image keeps its tab selected');
    assert.equal(hosts.imagePane.hidden, false);
    assert.equal(a.pendingImages.size, 0, 'published images use the normal file map');
    rt.files.set('plot.png', new Uint8Array([0, 4, 5, 6]));
    await a.showImage('plot.png');
    await a.publish(rt);
    assert.equal(hosts.imagePane.children[0]?.src, 'data:image/png;base64,AAQFBg==');
    assert.equal(groups.current.active, 'plot.png', 'publishing a regenerated image also keeps its tab selected');
    assert.equal(groups.current.tabs.filter(path => path === 'plot.png').length, 1);
  } finally { globalThis.document = previousDocument; }
});

for (const typed of ['', ' local']) test(`rejoin restores every background view and remote updates${typed ? ' with pending edits' : ''}`, async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ remove() {} }), head: { appendChild() {} } };
  const a = fixture();
  a.ui = {}; // Split-view mode; the focused editor is a different file.
  a.texts.put('main.py', 'base');
  const m = a.texts.model('main.py');
  const old = new DocSession(1, 'main.py', { id: 1, name: 'one' }, () => {});
  const room = new DocSession(1, 'main.py', { id: 1, name: 'one' }, () => {});
  const remote = new Y.Doc();
  try {
    old.seed('base'); room.seed('room');
    old.bindModel(a.monaco, m);
    if (typed) old.edit(4, 0, typed);
    a.docs.set('main.py', old);
    for (const id of ['left', 'middle']) {
      const held = view(m);
      held.attached = 'main.py'; held.detach = old.attachView(held.editor, m);
      a.editorViews.set(id, held);
    }
    const focused = view(a.texts.model('util.py'));
    a.editorViews.set('right', focused); a.editor = focused.editor;
    a.groupId = 'right';
    a.readyDoc = async path => { a.docs.set(path, room); return room; };
    await a.rejoin('main.py', old);
    assert(room.bound, 'the replacement document binds without focusing its tab');
    for (const id of ['left', 'middle']) assert.equal(a.editorViews.get(id).attached, 'main.py');
    assert.equal(a.active, 'util.py'); assert.equal(a.groupId, 'right');
    assert.equal(a.editor, focused.editor);
    assert.equal(room.contents(), 'room' + typed);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(room.ydoc));
    remote.getText('content').insert(0, 'remote ');
    room.applyUpdate(Y.encodeStateAsUpdate(remote));
    for (const id of ['left', 'middle']) assert.equal(a.editorViews.get(id).editor.getModel().getValue(), 'remote room' + typed);
  } finally {
    old.destroy(); room.destroy(); remote.destroy();
    globalThis.document = previousDocument;
  }
});

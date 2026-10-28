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
    if (name === './proto') return load('web/src/proto.ts');
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
const { SessionDocuments } = load('web/src/documents.ts');
const { parseJson, DocKind, untag } = load('web/src/proto.ts');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
  static fromPositions(a, b) { return new Range(a.lineNumber, a.column, b.lineNumber, b.column); }
}
function model(text) {
  const listeners = new Set();
  let disposed = false;
  return {
    getValue: () => text,
    getValueLength: () => text.length,
    getEOL: () => '\n',
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
    isDisposed: () => disposed,
    onDidChangeContent(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    applyEdits(edits) {
      const changes = edits.map(e => ({ rangeOffset: e.range.startColumn - 1, rangeLength: e.range.endColumn - e.range.startColumn, text: e.text }));
      for (const c of changes) text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
      for (const fn of listeners) fn({ changes });
    },
    pushEditOperations(_, edits) { this.applyEdits(edits); },
    dispose() { disposed = true; },
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
  const liveStates = new Map([[left, { cursor: 56, scroll: 120 }], [right, { cursor: 78, scroll: 240 }]]);
  for (const [id, held] of a.editorViews) held.editor.saveViewState = () => {
    assert(!held.editor.getModel().isDisposed(), 'capture the live state before model disposal');
    return liveStates.get(id);
  };
  a.editor = a.editorViews.get(left).editor;
  const groups = groupsFor(a, layout);
  await a.refresh();
  assert.equal(groups.model.groups.length, 2);
  assert.deepEqual(groups.model.group(left).tabs, ['new/a.py']);
  assert.deepEqual(groups.model.group(right).tabs, ['new/a.py', 'new/b.py']);
  assert.equal(groups.model.group(right).active, 'new/b.py');
  assert.deepEqual(a.editorViews.get(left).states.get('new/a.py'), liveStates.get(left));
  assert.deepEqual(a.editorViews.get(right).states.get('new/b.py'), liveStates.get(right));
  assert.deepEqual(a.viewStates.get('new/a.py'), liveStates.get(left));
  assert.equal(a.active, 'new/a.py');
});

for (const roomText of ['base', 'REMOTE base']) test(`remote rename carries pending typing before opening the destination (${roomText})`, async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {createElement: () => ({remove() {}}), head: {appendChild() {}}};
  const writes = [], attachments = [];
  const a = fixture({
    read: async () => ({seq:2,files:{'new.py':{content:'base',encoding:'utf8'}}}),
    write: async (_, changes) => { writes.push(...changes); return 3; },
  });
  a.warm = a.saveSoon = a.say = a.unjournal = () => {};
  a.texts = new Texts((path, text) => {
    const m = model(text); m.onDidChangeContent(() => a.changed(path)); return m;
  });
  a.known.set('old.py', 'base'); a.texts.put('old.py', 'base LOCAL');
  a.active = 'old.py';
  const layout = new EditorLayoutModel(); layout.open('old.py'); layout.split('right');
  const groups = groupsFor(a, layout);
  for (const group of layout.groups) a.editorViews.set(group.id, {...view(a.texts.model('old.py')),states:new Map()});
  a.readyDoc = async path => {
    if (!a.docs.has(path)) {
      const doc = new DocSession(1, path, {id:1,name:'test'}, kind => { if (kind === 'update') a.dirty.add(path); });
      doc.seed(roomText); a.docs.set(path, doc);
    }
    return a.docs.get(path);
  };
  // Model the synchronous selection callbacks from renameMany: attach creates
  // the destination document immediately, before its asynchronous binding.
  groups.render = () => {
    for (const group of layout.groups) {
      const m = a.texts.model(group.active), held = a.editorViews.get(group.id);
      held.editor.getModel = () => m;
      attachments.push(a.attach(group.active, m));
    }
    a.renderFiles();
  };
  a.show = path => { a.active = path; groups.render(); };
  try {
    await a.refresh();
    await Promise.all(attachments);
    const expected = `${roomText} LOCAL`;
    assert.equal(a.docs.get('new.py').contents(), expected, 'the live destination keeps the typing and peer changes');
    for (const held of a.editorViews.values()) assert.equal(held.editor.getModel().getValue(), expected, 'both panes share the carried text');
    await a.saveEdits();
    assert.deepEqual(writes, [{path:'new.py',content:expected}], 'the carried edit is saved under the new path exactly once');
    assert(!a.texts.has('old.py'));
  } finally {
    for (const doc of a.docs.values()) doc.destroy();
    globalThis.document = previousDocument;
  }
});

test('host return requests visible files and retained edits without reopening clean history', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  let away = true;
  const frames = [], accepted = [], refused = [];
  const editor = {
    path: 'current.ts', models: new Map(), viewers: new Map([['focused', { current: 'current.ts' }]]),
    groups: { visiblePaths: new Set(['current.ts']), views: new Map() },
    problem() {}, setReadOnly() {},
  };
  const manager = new SessionDocuments(editor, {
    send(frame) {
      frames.push(frame);
      if (frame.streamId === 0 && parseJson(frame).t === 'open') {
        const { path } = parseJson(frame);
        (accepted.length < 16 ? accepted : refused).push(path);
      }
    },
    online: () => true, away: () => away, readOnly: () => false,
    copy: () => null, user: () => ({ id: 1, name: 'test' }), unsent() {},
  });
  const hold = (path, text, unconfirmed = []) => {
    const file = manager.file(path);
    file.held = { local: 'saved', sent: { confirmed: new Uint8Array(), unconfirmed, client: 1 } };
    editor.models.set(path, { getValue: () => text });
  };
  try {
    // Clean files remain cached after subscriptions have been released.
    for (let i = 0; i < 32; i++) manager.file(`visited-${i}.ts`);
    hold('clean-snapshot.ts', 'saved');
    hold('closed-with-edits.ts', 'saved', [{ update: new Uint8Array([1]), to: 1 }]);
    hold('typed-offline.ts', 'changed offline');
    const live = manager.file('hidden-live-edits.ts');
    live.doc = { docId: 99, waiting: true, fullState: () => new Uint8Array([7]), destroy() {} };
    live.ready = true;
    const cleanLive = manager.file('hidden-clean.ts');
    cleanLive.doc = { docId: 100, waiting: false, fullState() { assert.fail('clean hidden state must not be resent'); }, destroy() {} };
    cleanLive.ready = true;
    manager.sync(); // Select a later file while the host is still away.
    away = false;
    manager.hostBack();
    assert.deepEqual(accepted.sort(), ['closed-with-edits.ts', 'current.ts', 'typed-offline.ts']);
    assert.deepEqual(refused, [], 'historical files do not consume the 16-document limit');
    assert.equal(cleanLive.doc, null, 'clean hidden subscriptions are released');
    const updates = frames.filter(frame => frame.streamId === 99);
    assert.equal(updates.length, 1, 'unconfirmed live edits still resend their state');
    assert.equal(untag(updates[0].payload)[0], DocKind.Update);
    assert(!frames.some(frame => frame.streamId === 100));
  } finally {
    manager.dispose(); globalThis.document = previousDocument;
  }
});

test('pane replacement frees host capacity before opening, including on host return', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    for (const method of ['sync', 'hostBack']) {
      const visible = new Set([...Array.from({length:14}, (_, i) => `file-${i + 2}.ts`), 'next.ts']);
      const subscribed = new Set(Array.from({length:16}, (_, i) => i));
      const operations = [], refused = [];
      const editor = {
        path: 'next.ts', models: new Map(),
        viewers: new Map([...visible].map(path => [path, {current:path}])),
        groups: {visiblePaths:visible, views:new Map()}, setReadOnly() {},
      };
      const manager = new SessionDocuments(editor, {
        send(frame) {
          if (frame.streamId !== 0) return;
          const msg = parseJson(frame);
          if (msg.t === 'close') { operations.push(`close:${msg.doc_id}`); subscribed.delete(msg.doc_id); }
          if (msg.t === 'open') {
            operations.push(`open:${msg.path}`);
            if (subscribed.size >= 16) refused.push(msg.path);
            else subscribed.add(16);
          }
        },
        online: () => true, away: () => false, readOnly: () => false,
        copy: () => null, user: () => ({id:1,name:'test'}), unsent() {},
      });
      try {
        for (let i = 0; i < 16; i++) {
          const file = manager.file(`file-${i}.ts`);
          file.doc = {docId:i, waiting:i === 1, fullState: () => new Uint8Array([7]), destroy() {}};
          file.ready = true;
        }
        manager.file('next.ts');
        manager[method]();
        assert.deepEqual(operations, ['close:0', 'open:next.ts'], `${method} closes before opening at capacity`);
        assert.deepEqual(refused, [], `${method} never causes a temporary capacity refusal`);
        assert(manager.file('file-1.ts').doc, 'hidden unconfirmed edits keep their subscription');
        assert.equal(subscribed.size, 16);
      } finally { manager.dispose(); }
    }
  } finally { globalThis.document = previousDocument; }
});

test('remote refresh preserves published and pending image tabs, falling back only for removed files', async () => {
  for (const state of ['published', 'pending', 'deleted']) {
    const files = {'util.py':{content:'changed remotely',encoding:'utf8'}};
    if (state === 'published') files['plot.png'] = {content:'AAECAw==',encoding:'base64'};
    const a = fixture({read: async () => ({seq:2,files})});
    a.warm = () => {};
    a.known.set('util.py', 'utility');
    a.active = 'plot.png';
    if (state === 'pending') a.pendingImages.add('plot.png');
    else a.binaries.set('plot.png', 'AAECAw==');
    const layout = new EditorLayoutModel(); layout.open('util.py');
    const background = layout.current.id;
    layout.split('right'); layout.open('plot.png');
    const groups = groupsFor(a, layout);
    a.show = path => { a.active = path; groups.open(path); };
    await a.refresh();
    const selected = state === 'deleted' ? 'util.py' : 'plot.png';
    assert.equal(a.active, selected, `${state}: refresh preserves a valid selected file`);
    assert.equal(groups.current.active, selected);
    assert.equal(groups.model.group(background).active, 'util.py', 'the background pane is preserved');
    assert.equal(a.texts.get('util.py').getValue(), 'changed remotely');
  }
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

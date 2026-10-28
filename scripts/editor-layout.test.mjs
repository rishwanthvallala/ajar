import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorLayoutModel, readLayout } from '../packages/workspace-ui/src/editor-layout.ts';

test('persistent tabs deduplicate within a group and share paths across groups', () => {
  const m = new EditorLayoutModel(); m.open('src/main.ts'); m.open('src/util.ts'); m.open('src/main.ts');
  assert.deepEqual(m.current.tabs, ['src/main.ts', 'src/util.ts']);
  const left = m.current.id; const right = m.split('right');
  assert.equal(right.active, 'src/main.ts'); assert.equal(m.group(left).active, 'src/main.ts');
  m.split('down'); assert.equal(m.groups.length, 3); assert.equal(m.state.root.second.direction, 'down');
});
test('closing selects the right tab then the left, collapses empty splits and keeps one empty group', () => {
  const m = new EditorLayoutModel(); m.open('a'); m.open('b'); m.open('c'); m.open('b'); m.close('b');
  assert.equal(m.current.active, 'c'); m.close('c'); assert.equal(m.current.active, 'a');
  const left = m.current.id; m.split('right'); m.close('a'); assert.equal(m.groups.length, 1); assert.equal(m.current.id, left);
  m.close('a'); assert.equal(m.groups.length, 1); assert.equal(m.current.active, null);
});
test('tab moves reorder and merge an existing destination tab without duplicates', () => {
  const m = new EditorLayoutModel(); m.open('a'); m.open('b'); m.open('c'); const left = m.current.id;
  m.move('a', left, left, 3); assert.deepEqual(m.current.tabs, ['b', 'c', 'a']);
  const right = m.split('right'); m.move('a', left, right.id); assert.deepEqual(right.tabs, ['a']); assert.deepEqual(m.group(left).tabs, ['b', 'c']);
  m.move('b', left, right.id, 0); assert.deepEqual(right.tabs, ['b', 'a']);
});
test('rename and pruning update all groups and preserve an intentionally empty layout', () => {
  const m = new EditorLayoutModel(); m.open('old'); m.split('right'); m.rename('old', 'new');
  assert(m.groups.every(g => g.active === 'new')); m.prune(() => false);
  assert.equal(m.groups.length, 1); assert.equal(m.current.active, null);
  assert.deepEqual(readLayout(JSON.stringify(m.state)), m.state);
});
test('restore validates structure, focus, ratios and duplicate identities', () => {
  assert.equal(readLayout('{bad'), null); assert.equal(readLayout('{"version":2}'), null);
  const m = new EditorLayoutModel(); m.open('a'); m.split('right'); const saved = JSON.parse(JSON.stringify(m.state));
  saved.focused = 'missing'; saved.root.ratio = 12; saved.root.first.tabs.push('a', 42); saved.root.first.active = 'missing';
  const restored = readLayout(JSON.stringify(saved)); assert.equal(restored.root.ratio, .9); assert.deepEqual(restored.root.first.tabs, ['a']); assert.equal(restored.focused, restored.root.first.id);
  saved.root.second.id = saved.root.first.id; assert.equal(readLayout(JSON.stringify(saved)), null);
});

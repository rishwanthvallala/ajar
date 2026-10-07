import * as monaco from "monaco-editor/editor/editor.api";

/**
 * Make a model's text `text` by replacing only what differs — the stretch
 * between the longest common start and the longest common end — rather than
 * all of it. `setValue`, or a fresh model, throws away where the view and the
 * cursor were and opens at line 1; an edit keeps them, and moves them only as
 * far as the text before them changed.
 *
 * The same function as Pad's, which found it first: reconnecting put a
 * reader back at the top of a long file, and the next keystroke landed there.
 */
export function replaceText(model: monaco.editor.ITextModel, text: string): void {
  const old = model.getValue();
  if (old === text) return;
  const limit = Math.min(old.length, text.length);
  let start = 0;
  while (start < limit && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  // Never split a surrogate pair: back off to the start of one.
  if (start > 0 && start < old.length && /[\udc00-\udfff]/.test(old[start]!)) start--;
  let end = 0;
  while (end < Math.min(old.length, text.length) - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(old.length - end));
  model.applyEdits([{ range, text: text.slice(start, text.length - end) }]);
}

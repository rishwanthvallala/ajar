/**
 * What the sandbox starts with.
 *
 * Split out of `app.ts` because the moment this runs is a race and a race is
 * untestable from the outside. The runtime is created synchronously inside the
 * first content change any model reports, and the editor binding is what
 * reports it — so the snapshot is taken *during* the binding, with whatever the
 * model happens to hold at that instant. Three attempts at catching the bug
 * below through the browser all passed against the broken code, because the
 * race simply did not land that way in the check. As a function it is ordinary.
 */

/** Only what the snapshot reads, so the checks can pass plain objects. */
export interface Model {
  getValue(): string;
}
export interface Doc {
  contents(): string;
}

/**
 * The pad's contents, in the order each source becomes true.
 *
 * The store is the base layer because it is the only one that is *already*
 * right when the runtime starts. A file's model can still be empty then — the
 * stored copy reaches the document first and the model is filled from the
 * binding afterwards — so snapshotting the models alone seeded the sandbox with
 * the right filenames and no contents. Opening a shared link and running a file
 * you had not touched did nothing at all, silently, which is the one thing
 * sharing a link is for.
 *
 * The editor still wins where it has something, so unsaved edits run: a model
 * is preferred when it is non-empty, and an empty one is taken only for a file
 * the store has never heard of — a new, still-empty file, which is the only
 * case where empty is the truth rather than a file that has not loaded yet.
 */
export function seedFiles(
  known: Map<string, string>,
  models: Map<string, Model>,
  docs: Map<string, Doc>,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, content] of known) files[path] = content;
  for (const [path, model] of models) {
    const text = docs.get(path)?.contents() ?? model.getValue();
    if (text || files[path] === undefined) files[path] = text;
  }
  return files;
}
